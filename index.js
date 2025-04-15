import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
// import * as github from '@actions/github'; // Not strictly needed for the core logic now
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from 'xmldom';

// --- Helper Functions ---

/**
 * Fetches content from a URL or reads from a local file.
 * @param {string} urlOrPath - The URL or local file path.
 * @param {Map<string, string>} assetMap - Map of relative asset paths to full paths.
 * @returns {Promise<string>} - The fetched or read content.
 */
async function getContent(urlOrPath, assetMap) {
  if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
    core.info(`Fetching remote URL: ${urlOrPath}`);
    const response = await fetch(urlOrPath);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${urlOrPath}: ${response.statusText} (Status: ${response.status})`);
    }
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('svg')) {
        core.warning(`Content-Type from ${urlOrPath} is '${contentType}', not SVG. Proceeding but might cause issues.`);
    }
    return await response.text();
  } else {
    // Assume local path relative to the repo root
    const relativePath = urlOrPath.startsWith('/') ? urlOrPath.substring(1) : urlOrPath;
    core.info(`Reading local file: ${relativePath}`);
    if (!assetMap.has(relativePath)) {
      // Try resolving relative to CWD just in case
      const absolutePath = path.resolve(relativePath);
      const cwdRelative = path.relative(process.cwd(), absolutePath);
      if (assetMap.has(cwdRelative)) {
        core.info(`Resolved local file to: ${cwdRelative}`);
        return await fs.readFile(assetMap.get(cwdRelative), 'utf8');
      }
      throw new Error(`Local asset not found in asset map: ${relativePath}`);
    }
    return await fs.readFile(assetMap.get(relativePath), 'utf8');
  }
}

/**
 * Updates IDs within an element and its descendants to be unique.
 * Also updates references to those IDs (like url(#id), href="#id").
 * @param {Element} element - The element to process.
 * @param {string} idPrefix - The prefix to add to existing IDs.
 * @param {Map<string, string>} idMap - A map to store oldId -> newId mappings.
 */
function prefixIdsAndReferences(element, idPrefix, idMap) {
  if (element.nodeType !== 1) return; // Only process element nodes

  const oldId = element.getAttribute('id');
  if (oldId) {
    const newId = `${idPrefix}${oldId}`;
    element.setAttribute('id', newId);
    idMap.set(oldId, newId); // Store the mapping
    core.debug(`Mapped ID: ${oldId} -> ${newId}`);
  }

  // Attributes that commonly reference IDs
  const refAttrs = ['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'];
  const hrefAttrs = ['href', 'xlink:href']; // Separate check for #id format

  // Update url(#id) references in attributes
  for (const attr of refAttrs) {
    const value = element.getAttribute(attr);
    if (value && value.includes('url(#')) {
      let newValue = value;
      // Iterate through all known ID mappings for replacement
      for (const [oldRefId, newRefId] of idMap.entries()) {
          // Use regex for safer replacement (avoids partial matches)
          const urlPattern = new RegExp(`url\\(#${oldRefId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\)`, 'g'); // Escape special regex chars in ID
          newValue = newValue.replace(urlPattern, `url(#${newRefId})`);
      }
      if (newValue !== value) {
        element.setAttribute(attr, newValue);
        core.debug(`Updated attribute ${attr} on <${element.tagName}> to: ${newValue}`);
      }
    }
  }

  // Update href="#id" or xlink:href="#id" references
   for (const attr of hrefAttrs) {
       const value = element.getAttribute(attr);
       if (value && value.startsWith('#')) {
           const oldRefId = value.substring(1);
           if (idMap.has(oldRefId)) {
               const newRefId = idMap.get(oldRefId);
               element.setAttribute(attr, `#${newRefId}`);
               core.debug(`Updated attribute ${attr} on <${element.tagName}> to: #${newRefId}`);
           }
       }
   }


  // Recursively process child elements
  for (let i = 0; i < element.childNodes.length; i++) {
    prefixIdsAndReferences(element.childNodes[i], idPrefix, idMap);
  }
}

/**
 * Scopes CSS rules within a <style> tag by prefixing selectors.
 * @param {string} cssText - The original CSS text.
 * @param {string} scopeSelector - The selector to prefix rules with (e.g., `#group-id `).
 * @returns {string} - The scoped CSS text.
 */
function scopeCss(cssText, scopeSelector) {
    // This is a simplified approach. A full CSS parser would be more robust.
    // It aims to prefix class/ID selectors and keyframes, handling nested structures.
    // It might struggle with very complex selectors or @rules.
    try {
        // 1. Prefix keyframes definitions and references
        cssText = cssText.replace(/@keyframes\s+([^{\s]+)/g, (match, keyframeName) => {
            return `@keyframes ${scopeSelector.trim()}-${keyframeName}`;
        });
        cssText = cssText.replace(/(animation(?:-name)?\s*:\s*)([^;\s]+)/g, (match, property, value) => {
            // Avoid prefixing animation keywords like 'infinite', 'linear', etc.
            // This is heuristic - might need refinement based on actual CSS used.
            if (['infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'forwards', 'backwards', 'both', 'none', 'running', 'paused'].includes(value) || /^\d/.test(value)) {
                return match; // Don't prefix keywords or timings
            }
            return `${property}${scopeSelector.trim()}-${value}`;
        });

        // 2. Prefix selectors (basic class/id/element, avoids @rules for now)
        // Split by braces to handle rules individually
        const parts = cssText.split(/([{}]|\/\*[\s\S]*?\*\/)/); // Split by {, }, and comments
        let scopedCss = '';
        let depth = 0;
        let inComment = false;
        let currentSelectors = [];

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();

            if (part.startsWith('/*')) {
                scopedCss += parts[i]; // Keep original comment spacing
                inComment = true;
                continue;
            }
            if (part.endsWith('*/')) {
                scopedCss += parts[i];
                inComment = false;
                continue;
            }
            if (inComment || part === '') {
                scopedCss += parts[i];
                continue;
            }

            if (part === '{') {
                if (depth === 0 && currentSelectors.length > 0) {
                    // Apply scope to top-level selectors
                    const scopedSelectors = currentSelectors.map(selector => {
                        // Don't scope @-rules or universal selector directly
                        if (selector.startsWith('@') || selector === '*') {
                            return selector;
                        }
                        // Basic prefixing - might need enhancement for complex selectors like :not()
                        return `${scopeSelector}${selector}`;
                    }).join(', ');
                    scopedCss += scopedSelectors + ' {';
                } else {
                    // Inside nested rule or no selectors found before brace
                     scopedCss += currentSelectors.join(', ') + ' {';
                }
                currentSelectors = []; // Reset selectors
                depth++;
            } else if (part === '}') {
                scopedCss += '}';
                depth--;
            } else if (depth === 0) {
                // Accumulate selectors before the first opening brace
                currentSelectors = part.split(',').map(s => s.trim()).filter(s => s !== '');
            } else {
                // Inside a rule block, keep content as is
                scopedCss += parts[i];
            }
        }

        return scopedCss;

    } catch (e) {
        core.warning(`Could not scope CSS for ${scopeSelector}: ${e.message}. Using original CSS.`);
        return cssText; // Fallback to original if parsing/scoping fails
    }
}


// --- Main Action Logic ---
async function run() {
  try {
    // Get inputs
    const layoutInput = core.getInput('layout', { required: true });
    const assetsInput = core.getInput('assets', { required: false }) || 'images/*.svg,images/*.png'; // Keep png for asset map if needed elsewhere
    const outputFile = core.getInput('output-file', { required: false }) || 'merged.svg'; // Default output file name
    const commitMessage = core.getInput('commit-message', { required: false }) || 'ci: update merged profile SVG';
    const token = core.getInput('token', { required: true }); // Needed for push

    // --- 1. Parse Layout ---
    let layout;
    try {
      layout = JSON.parse(layoutInput);
      if (!Array.isArray(layout)) {
        throw new Error('Layout input must be a JSON array');
      }
      core.info(`Parsed layout with ${layout.length} items.`);
    } catch (error) {
      core.setFailed(`Invalid layout JSON: ${error.message}`);
      return;
    }

    // --- 2. Prepare Asset Map ---
    const assetMap = new Map();
    const assetPatterns = assetsInput.split(',').map(pattern => pattern.trim());
    core.info(`Searching for assets matching: ${assetPatterns.join(', ')}`);
    for (const pattern of assetPatterns) {
      const globber = await glob.create(pattern, { followSymbolicLinks: false }); // Avoid issues with symlinks
      for await (const file of globber.globGenerator()) {
        // Store paths relative to the repo root (process.cwd())
        const relativePath = path.relative(process.cwd(), file).replace(/\\/g, '/'); // Normalize slashes
        assetMap.set(relativePath, file);
        core.debug(`Found asset: ${relativePath} -> ${file}`);
      }
    }
    core.info(`Found ${assetMap.size} local assets.`);

    // --- 3. Initialize Root SVG ---
    const parser = new DOMParser();
    const serializer = new XMLSerializer();

    // Define background dimensions
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;

    const rootSvgString = `<svg width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <defs id="global-defs"></defs>
        <rect x="${minX}" y="${minY}" width="${svgWidth}" height="${svgHeight}" fill="transparent" id="background-rect"/>
        </svg>`;
    const rootSvg = parser.parseFromString(rootSvgString, 'image/svg+xml');
    const rootElement = rootSvg.documentElement;
    const globalDefs = rootElement.getElementsByTagName('defs')[0];
    const globalStyles = rootSvg.createElement('style');
    globalStyles.setAttribute('id', 'global-styles');
    rootElement.insertBefore(globalStyles, globalDefs.nextSibling); // Insert styles after defs

    // --- 4. Process Layout Items ---
    for (const item of layout) {
      core.startGroup(`Processing item: ${item.id} (${item.url})`);
      try {
        // Validate item structure
        if (!item.id || !item.url || !item.type || item.x === undefined || item.y === undefined || item.width === undefined || item.height === undefined) {
            core.warning(`Skipping item due to missing properties: ${JSON.stringify(item)}`);
            continue;
        }

        // We only inline SVG types as requested
        if (item.type !== 'svg') {
          core.info(`Skipping item ${item.id} as its type is '${item.type}', not 'svg'.`);
          continue;
        }

        // Fetch/Read SVG Content
        const svgContent = await getContent(item.url, assetMap);
        if (!svgContent || !svgContent.includes('<svg')) {
            throw new Error(`Content from ${item.url} does not appear to be valid SVG.`);
        }

        // Parse the fetched SVG
        const itemSvgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
        const itemSvgElement = itemSvgDoc.documentElement;

        // --- Create Group for this item ---
        const group = rootSvg.createElement('g');
        const groupId = `item-${item.id}`; // Unique group ID
        group.setAttribute('id', groupId);

        // --- Calculate Transform (Translate & Scale) ---
        let originalWidth, originalHeight;
        const viewBox = itemSvgElement.getAttribute('viewBox');
        const widthAttr = itemSvgElement.getAttribute('width');
        const heightAttr = itemSvgElement.getAttribute('height');

        if (widthAttr && heightAttr) {
            originalWidth = parseFloat(widthAttr);
            originalHeight = parseFloat(heightAttr);
        } else if (viewBox) {
            const parts = viewBox.split(/[\s,]+/);
            originalWidth = parseFloat(parts[2]);
            originalHeight = parseFloat(parts[3]);
        } else {
            core.warning(`Item ${item.id}: Cannot determine original dimensions from SVG attributes or viewBox. Using layout dimensions ${item.width}x${item.height}. Scaling might be incorrect.`);
            originalWidth = item.width;
            originalHeight = item.height;
        }

        if (isNaN(originalWidth) || isNaN(originalHeight) || originalWidth <= 0 || originalHeight <= 0) {
             core.warning(`Item ${item.id}: Invalid original dimensions (${originalWidth}x${originalHeight}). Using layout dimensions ${item.width}x${item.height}. Scaling might be incorrect.`);
             originalWidth = item.width;
             originalHeight = item.height;
        }

        const scaleX = item.width / originalWidth;
        const scaleY = item.height / originalHeight;
        group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX.toFixed(6)}, ${scaleY.toFixed(6)})`); // Use toFixed for cleaner output

        // --- Process <defs> ---
        const itemDefs = itemSvgElement.getElementsByTagName('defs')[0];
        const idMap = new Map(); // Map old IDs to new prefixed IDs for this item
        const idPrefix = `item_${item.id}_`; // Unique prefix for IDs from this SVG

        if (itemDefs) {
          core.debug(`Processing ${itemDefs.childNodes.length} defs elements for item ${item.id}`);
          // First pass: Prefix IDs within the defs themselves and store mapping
          for (let i = 0; i < itemDefs.childNodes.length; i++) {
              const node = itemDefs.childNodes[i];
              if (node.nodeType === 1 && node.getAttribute('id')) { // Element node with an ID
                  const oldId = node.getAttribute('id');
                  const newId = `${idPrefix}${oldId}`;
                  node.setAttribute('id', newId); // Modify ID *before* cloning
                  idMap.set(oldId, newId);
                  core.debug(`Mapped def ID: ${oldId} -> ${newId}`);
              }
          }
          // Second pass: Clone and append defs to global defs
           for (let i = 0; i < itemDefs.childNodes.length; i++) {
               const node = itemDefs.childNodes[i];
               if (node.nodeType === 1) { // Element node
                   // Update any internal references *within* the def itself (e.g., gradient referencing another gradient)
                   prefixIdsAndReferences(node, idPrefix, idMap); // Apply recursively *within* the def
                   globalDefs.appendChild(node.cloneNode(true)); // Append modified node to global defs
               } else if (node.nodeType === 3 && node.nodeValue.trim()) { // Non-empty text node
                   globalDefs.appendChild(node.cloneNode(true));
               } else if (node.nodeType === 8) { // Comment node
                   globalDefs.appendChild(node.cloneNode(true));
               }
           }
        }

        // --- Process <style> (CSS Animations) ---
        const itemStyles = itemSvgElement.getElementsByTagName('style');
        let itemScopedCss = '';
        for (let i = 0; i < itemStyles.length; i++) {
          const styleElement = itemStyles[i];
          const originalCss = styleElement.textContent || styleElement.text || ''; // Handle potential browser differences (though xmldom uses textContent)
          if (originalCss.trim()) {
            core.debug(`Scoping styles for item ${item.id}`);
            // Scope CSS rules by prefixing with the group ID selector
            itemScopedCss += scopeCss(originalCss, `#${groupId} `) + '\n';
          }
        }
        if (itemScopedCss) {
            globalStyles.textContent += `/* Styles for item ${item.id} */\n${itemScopedCss}\n`;
            core.info(`Added scoped styles for item ${item.id}`);
        }


        // --- Copy Content, Update References, and Append to Group ---
        core.debug(`Copying content elements for item ${item.id}`);
        for (let i = 0; i < itemSvgElement.childNodes.length; i++) {
          const node = itemSvgElement.childNodes[i];

          // Skip already processed defs and style elements
          if (node.nodeName === 'defs' || node.nodeName === 'style') {
            continue;
          }

          // Skip metadata, title, desc? Optional, but often safe.
          if (['metadata', 'title', 'desc'].includes(node.nodeName)) {
              continue;
          }

          if (node.nodeType === 1 || (node.nodeType === 3 && node.nodeValue.trim()) || node.nodeType === 8) { // Element, Non-empty text, Comment
            const clonedNode = node.cloneNode(true);

            // IMPORTANT: Update IDs and references within the cloned content
            // Use the idMap created during defs processing
            if (clonedNode.nodeType === 1) { // Only elements can have IDs/references
                 prefixIdsAndReferences(clonedNode, idPrefix, idMap);
            }

            group.appendChild(clonedNode);
          }
        }

        // Append the fully processed group to the root SVG
        rootElement.appendChild(group);
        core.info(`Successfully processed and added item ${item.id}`);

      } catch (error) {
        core.warning(`Error processing item ${item.id} (${item.url}): ${error.message}`);
        core.warning(error.stack); // Log stack for debugging
      } finally {
          core.endGroup();
      }
    }

    // --- 5. Serialize and Optimize ---
    let finalSvgString = serializer.serializeToString(rootSvg);

    core.info('Optimizing final SVG with SVGO...');
    try {
        const optimizedSvg = optimize(finalSvgString, {
            multipass: true, // Run multiple passes for better optimization
            plugins: [
                {
                    name: 'preset-default',
                    params: {
                        overrides: {
                            // --- Presets to disable ---
                            // IMPORTANT for animations & structure:
                            removeViewBox: false, // Keep the main viewBox
                            cleanupIDs: false, // We handled ID prefixing manually
                            inlineStyles: false, // Keep <style> tags for animations
                            minifyStyles: false, // Keep <style> content readable (and potentially safer for complex CSS)
                            removeUselessDefs: false, // Defs might be used by styles/scripts we don't parse
                            collapseGroups: false, // Keep groups for structure and transforms
                            moveElemsAttrsToGroup: false, // Keep attributes on elements
                            moveGroupAttrsToElems: false, // Keep attributes on groups
                            convertShapeToPath: false, // Might break specific styling/animations
                            mergePaths: false, // Can break structure needed for animations
                            // Generally safe to keep enabled or disable based on testing:
                            removeMetadata: true,
                            removeTitle: true,
                            removeDesc: true,
                            removeComments: true,
                            removeDoctype: true,
                            removeXMLProcInst: true,
                            removeEditorsNSData: true,
                            cleanupNumericValues: { floatPrecision: 3 }, // Reduce precision slightly
                            convertColors: { currentColor: true, names2hex: true, rgb2hex: true, shorthex: false, shortname: true },
                            removeUnknownsAndDefaults: { unknownContent: true, unknownAttrs: true, defaultAttrs: true, addUsedNamespace: true }, // Be careful with this one
                            removeNonInheritableGroupAttrs: true,
                            removeUselessStrokeAndFill: false, // Can sometimes remove fills needed by context
                            removeUnusedNS: true,
                            cleanupAttrs: true, // Clean up whitespace in attributes
                            convertStyleToAttrs: false, // Keep styles in <style>
                            convertTransform: true, // Consolidate transforms if possible (usually safe)
                            removeEmptyAttrs: true,
                            removeEmptyText: true,
                            removeEmptyContainers: false, // Keep empty groups if they have IDs/transforms
                            cleanupEnableBackground: true,
                            sortAttrs: true, // Sort attributes for consistency
                            sortDefsChildren: true, // Sort defs for consistency
                        },
                    },
                },
                // Add other specific plugins if needed, e.g., removeDimensions: true (if width/height aren't needed on root)
            ],
        });
        finalSvgString = optimizedSvg.data;
        core.info('SVGO optimization complete.');
    } catch (svgoError) {
        core.warning(`SVGO optimization failed: ${svgoError.message}. Using unoptimized SVG.`);
        // finalSvgString remains the unoptimized version
    }


    // --- 6. Write Output File ---
    const outputDir = path.dirname(outputFile);
    if (outputDir !== '.') {
        await fs.mkdir(outputDir, { recursive: true });
        core.info(`Created output directory: ${outputDir}`);
    }
    await fs.writeFile(outputFile, finalSvgString);
    core.info(`Successfully wrote merged SVG to ${outputFile}`);

    // --- 7. Commit and Push Changes (Optional based on workflow setup) ---
    // This part assumes the workflow wants the action to commit.
    // The provided workflow YAML *does* handle the commit itself after this action runs,
    // so this Git part might be redundant *if* the workflow copies the file correctly.
    // However, keeping it provides flexibility if the workflow changes.
    // Let's make it conditional or rely on the workflow's commit step.

    // **Decision**: The workflow *already* copies `merged.svg` to `public/` and commits `public/merged.svg`.
    // Therefore, this action *should not* commit. It just needs to produce `merged.svg`.
    // Commenting out the Git commands.

    /*
    core.info('Checking for changes to commit...');
    await exec.exec('git', ['config', 'user.name', '"github-actions[bot]"']);
    await exec.exec('git', ['config', 'user.email', '"github-actions[bot]@users.noreply.github.com"']);

    // Add the specific output file
    await exec.exec('git', ['add', outputFile]);

    // Check if there are staged changes for the output file
    const diffResult = await exec.getExecOutput('git', ['diff', '--staged', '--quiet', outputFile], { ignoreReturnCode: true });

    if (diffResult.exitCode === 1) { // 1 means differences exist
      core.info(`Changes detected in ${outputFile}. Committing...`);
      await exec.exec('git', ['commit', '-m', commitMessage]);

      core.info('Pushing changes...');
      const repository = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
      // Ensure the branch is correctly checked out - Actions checkout usually handles this
      // await exec.exec('git', ['push', repository, `HEAD:${process.env.GITHUB_REF_NAME}`]); // Push to the current branch
      await exec.exec('git', ['push', repository]); // Simpler push often works

      core.info(`Successfully committed and pushed ${outputFile}`);
    } else if (diffResult.exitCode === 0) {
      core.info(`No changes detected in ${outputFile}. Nothing to commit.`);
    } else {
      core.warning(`git diff command failed with exit code ${diffResult.exitCode}.`);
    }
    */

    core.setOutput('output_path', outputFile); // Output the path for potential use in later steps

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}\n${error.stack}`);
  }
}

run();

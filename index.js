import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
// *** Import DOMParser and XMLSerializer from xmldom ***
import { DOMParser, XMLSerializer } from 'xmldom';

async function run() {
  try {
    // Get inputs from action
    const layoutInput = core.getInput('layout', { required: true });
    const assetsInput = core.getInput('assets', { required: false }) || 'images/*.svg';
    const token = core.getInput('token', { required: true });

    // Parse layout JSON
    let layout;
    try {
      layout = JSON.parse(layoutInput);
      if (!Array.isArray(layout)) {
        throw new Error('Layout must be a JSON array');
      }
    } catch (error) {
      core.setFailed(`Invalid layout JSON: ${error.message}`);
      return;
    }

    // *** Initialize parser and serializer ***
    const parser = new DOMParser();
    const serializer = new XMLSerializer();

    // Create a map of asset files for faster lookups
    const assetMap = new Map();
    const assetPatterns = assetsInput.split(',').map(pattern => pattern.trim());

    for (const pattern of assetPatterns) {
      const globber = await glob.create(pattern);
      const files = await globber.glob();

      for (const file of files) {
        const relativePath = path.relative(process.cwd(), file);
        assetMap.set(relativePath, file);
      }
    }

    // Set fixed dimensions for the SVG including background
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;

    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;

    // Create the root SVG with fixed dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );

    const rootElement = rootSvg.documentElement;

    // Add background as the first element
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', minX.toString());
    backgroundRect.setAttribute('y', minY.toString());
    backgroundRect.setAttribute('width', svgWidth.toString());
    backgroundRect.setAttribute('height', svgHeight.toString());
    backgroundRect.setAttribute('fill', 'white');
    rootElement.appendChild(backgroundRect);

    // *** Create a collection to store global definitions (<defs>) from all SVGs ***
    const defs = rootSvg.createElement('defs');
    rootElement.appendChild(defs);

    // *** Track used IDs globally across all merged SVGs to prevent conflicts ***
    const usedIds = new Set();

    // *** Helper function to make IDs unique by prefixing with item ID ***
    function makeIdUnique(id, itemId) {
      if (!id) return null;

      const newId = `${itemId}_${id}`;
      // While loop to ensure true uniqueness if conflicts arise from generated IDs
      // (less likely with itemId prefix, but possible if itemId itself contains underscores)
      let finalId = newId;
      let counter = 1;
      while (usedIds.has(finalId)) {
          finalId = `${newId}_${counter++}`;
      }
      usedIds.add(finalId);
      return finalId;
    }

    // *** Helper function to update ID references in attributes (url(#id), href="#id", SMIL) ***
    function updateIdReferences(element, oldId, newId) {
      // Common attributes that might reference IDs
      const idRefAttributes = [
        'href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start',
        'marker-mid', 'marker-end', 'begin', 'end', // SMIL animation attributes
        // 'attributeName', // Usually not an ID ref itself
        // 'by', 'from', 'to', 'values' // Usually values, not ID refs, but check just in case? Less common.
      ];

      // Check each attribute that might contain an ID reference
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const attrName = attr.name;
        let attrValue = attr.value;

        if (!attrValue) continue; // Skip empty attributes

        // Check for URL references like "url(#id)" or "url('#id')"
        const urlRegex = new RegExp(`url\\(['"]?#${oldId}['"]?\\)`, 'g');
        if (urlRegex.test(attrValue)) {
            attrValue = attrValue.replace(urlRegex, `url(#${newId})`);
        }
        // Check for direct ID references like "#id" (often in href/xlink:href)
        else if (attrValue === `#${oldId}`) {
            attrValue = `#${newId}`;
        }
        // Check for simple ID references (e.g., in 'begin', 'end' for SMIL)
        else if (idRefAttributes.includes(attrName)) {
            // Update animation timing references like "id.begin+1s", "id.end", "id.click" etc.
            // Need to be careful not to replace parts of other IDs. Use word boundaries or lookarounds.
            // Regex: Replace `oldId` when followed by a dot, semicolon, space, or end of string.
            const timingRegex = new RegExp(`(^|\\s|;)${oldId}(\\.|;|\\s|$)`, 'g');
            if (timingRegex.test(attrValue)) {
                attrValue = attrValue.replace(timingRegex, `$1${newId}$2`);
            }
            // Handle cases where the entire value might be the ID (less common for these attributes but possible)
            else if (attrValue === oldId) {
                 attrValue = newId;
            }
        }

        // Update the attribute value if it changed
        if (attrValue !== attr.value) {
            element.setAttribute(attrName, attrValue);
        }
      }
    }


    // *** Recursively process an element and its children to update IDs and references ***
    // Takes the element, the item ID (for prefixing), and the map of old->new IDs for this item
    function processElementIds(element, itemId, idMap) {
      // Only process element nodes (type 1)
      if (!element || element.nodeType !== 1) return;

      const originalId = element.getAttribute('id');

      // Process this element's ID if it has one
      if (originalId) {
        const newId = makeIdUnique(originalId, itemId);
        if (newId && newId !== originalId) {
          element.setAttribute('id', newId);
          idMap[originalId] = newId; // Store mapping for reference updates

          // Update references *within this element* that might point to its *own old ID*
          // (e.g., animations targeting the element itself)
          updateIdReferences(element, originalId, newId);
        }
      }

      // Process attributes that might reference *other* IDs already mapped
      // Apply all known mappings to the current element's attributes
      for (const [oldId, newId] of Object.entries(idMap)) {
          if (oldId !== originalId) { // Avoid reprocessing the ID we just set
              updateIdReferences(element, oldId, newId);
          }
      }

      // Process child elements recursively
      if (element.childNodes) {
        for (let i = 0; i < element.childNodes.length; i++) {
          // Pass the current idMap down, it will be augmented by children
          processElementIds(element.childNodes[i], itemId, idMap);
        }
      }
    }


    // Process each layout item
    for (const item of layout) {
      try {
        let content; // Will hold raw SVG string or data URI for non-SVG
        let isSvgType = item.type === 'svg'; // Flag to determine processing path

        // --- Fetch or Read Content ---
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          core.info(`Fetching content from URL: ${item.url}`);
          const response = await fetch(item.url);
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          const contentType = response.headers.get('content-type');

          if (isSvgType) {
            // *** Always fetch as text for SVG type ***
            content = await response.text();
            // Handle JSON responses containing SVG
            if (contentType?.includes('application/json')) {
              core.info(`Response from ${item.url} is JSON, attempting to extract SVG...`);
              try {
                const jsonData = JSON.parse(content);
                if (typeof jsonData.svg === 'string') content = jsonData.svg;
                else if (typeof jsonData.data === 'string') content = jsonData.data; // Common alternative field
                else if (typeof jsonData.content === 'string') content = jsonData.content; // Another possibility
                else throw new Error('Could not find SVG string in JSON fields "svg", "data", or "content".');
              } catch (e) {
                  core.warning(`Failed to parse JSON or extract SVG from ${item.url}: ${e.message}`);
                  // Content might still be valid SVG if JSON parsing failed, proceed cautiously
              }
            }
            // Handle SVG provided as a data URI within the fetched content
            if (content.startsWith('data:image/svg+xml;base64,')) {
              core.info(`Decoding base64 SVG data URI from ${item.url}`);
              const base64Data = content.replace('data:image/svg+xml;base64,', '');
              content = Buffer.from(base64Data, 'base64').toString('utf8');
            }
            // Basic validation
            if (!content.trim().startsWith('<svg') && !content.trim().startsWith('<?xml')) {
              throw new Error(`Content from ${item.url} does not appear to be valid SVG. Content starts with: ${content.substring(0, 100)}`);
            }
          } else { // Non-SVG remote content
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || `image/${item.type}` || 'image/png'; // Guess mime type if needed
            content = `data:${mimeType};base64,${base64}`; // Create data URI
          }
        } else if (item.url.startsWith('blob:') || item.url.startsWith('images/')) {
          // Handle local files (both 'blob:images/file.svg' and 'images/file.svg')
          const imagePath = item.url.startsWith('blob:') ? item.url.substring(5) : item.url;
          core.info(`Reading local file: ${imagePath}`);

          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}. Available assets: ${[...assetMap.keys()].join(', ')}`);
          }
          const fileBuffer = await fs.readFile(assetMap.get(imagePath));

          if (isSvgType) {
            // *** Read local SVG as text ***
            content = fileBuffer.toString('utf8'); // Raw SVG text
             // Basic validation
             if (!content.trim().startsWith('<svg') && !content.trim().startsWith('<?xml')) {
              throw new Error(`Content from ${imagePath} does not appear to be valid SVG.`);
            }
          } else { // Non-SVG local file
            const base64 = fileBuffer.toString('base64');
            // Infer mime type from extension if possible
            const ext = path.extname(imagePath).toLowerCase().substring(1);
            const mimeType = `image/${ext || item.type || 'png'}`;
            content = `data:${mimeType};base64,${base64}`; // Create data URI
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }

        // --- Process Content ---
        if (isSvgType) {
          // *** SVG Inlining Logic ***
          core.info(`Inlining SVG for item ${item.id} from ${item.url}`);
          // *** Parse the fetched/read SVG string ***
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;

          // *** Check for parser errors ***
          const parseErrors = svgElement.getElementsByTagName('parsererror');
          if (parseErrors.length > 0) {
              // Try to get more specific error info if available
              const errorText = parseErrors[0].textContent || 'Unknown parsing error';
              throw new Error(`Error parsing SVG content for item ${item.id}: ${errorText}`);
          }
          // Additional check: if root element is not <svg>, parsing likely failed silently or content was wrong
          if (svgElement.nodeName.toLowerCase() !== 'svg') {
              throw new Error(`Parsed content for item ${item.id} does not have a root <svg> element. Found <${svgElement.nodeName}> instead.`);
          }

          // *** Create a group (<g>) element to hold the inlined SVG content ***
          // This group will be transformed (positioned and scaled)
          const group = rootSvg.createElement('g');
          // Use a predictable ID for the group itself
          group.setAttribute('id', `item_${item.id}`);

          // --- Calculate Scaling based on intrinsic vs target dimensions ---
          let svgIntrinsicWidth, svgIntrinsicHeight;
          // Prefer viewBox for intrinsic dimensions as it defines the coordinate system
          if (svgElement.hasAttribute('viewBox')) {
            const viewBoxParts = svgElement.getAttribute('viewBox').split(/[\s,]+/);
            if (viewBoxParts.length === 4) {
                svgIntrinsicWidth = parseFloat(viewBoxParts[2]);
                svgIntrinsicHeight = parseFloat(viewBoxParts[3]);
                // Handle potential zero dimensions in viewBox
                if (svgIntrinsicWidth <= 0) svgIntrinsicWidth = NaN;
                if (svgIntrinsicHeight <= 0) svgIntrinsicHeight = NaN;
            }
          }
          // Fallback to width/height attributes if viewBox is missing or invalid
          if (isNaN(svgIntrinsicWidth) && svgElement.hasAttribute('width')) {
            svgIntrinsicWidth = parseFloat(svgElement.getAttribute('width'));
          }
          if (isNaN(svgIntrinsicHeight) && svgElement.hasAttribute('height')) {
            svgIntrinsicHeight = parseFloat(svgElement.getAttribute('height'));
          }

          // If dimensions still unknown, use target dimensions (implies scale=1)
          if (isNaN(svgIntrinsicWidth) || svgIntrinsicWidth <= 0) {
              core.warning(`Could not determine intrinsic width for SVG ${item.id}. Assuming target width ${item.width}.`);
              svgIntrinsicWidth = item.width;
          }
          if (isNaN(svgIntrinsicHeight) || svgIntrinsicHeight <= 0) {
              core.warning(`Could not determine intrinsic height for SVG ${item.id}. Assuming target height ${item.height}.`);
              svgIntrinsicHeight = item.height;
          }


          // --- Apply transformations (translate and scale) to the group ---
          let transform = `translate(${item.x}, ${item.y})`;
          // Add scaling only if necessary and possible
          if (svgIntrinsicWidth > 0 && svgIntrinsicHeight > 0 && (svgIntrinsicWidth !== item.width || svgIntrinsicHeight !== item.height)) {
            const scaleX = item.width / svgIntrinsicWidth;
            const scaleY = item.height / svgIntrinsicHeight;
            transform += ` scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`; // Use toFixed for cleaner output
          }
          group.setAttribute('transform', transform);


          // --- Process IDs, Defs, Styles, and Content within the fetched SVG ---
          const idMap = {}; // Map to track old ID -> new ID for *this* item

          // *** 1. Process IDs recursively throughout the *entire* parsed SVG structure first ***
          // This ensures all IDs are unique and the idMap is complete before moving elements.
          processElementIds(svgElement, item.id, idMap);

          // *** 2. Process Defs: Move children of <defs> to the root <defs> ***
          // The IDs within these defs should already be unique from step 1.
          const svgDefs = svgElement.getElementsByTagName('defs');
          for (let i = 0; i < svgDefs.length; i++) {
            const defElement = svgDefs[i];
            // Iterate backwards when moving nodes from a live NodeList
            for (let j = defElement.childNodes.length - 1; j >= 0; j--) {
              const defChild = defElement.childNodes[j];
              // Move only element nodes (type 1)
              if (defChild.nodeType === 1) {
                // Append the *original* node (already ID-processed) to the root defs
                defs.appendChild(defChild);
              }
            }
            // Remove the now-empty <defs> element from its original place
            if (defElement.parentNode) {
                defElement.parentNode.removeChild(defElement);
            }
          }

          // *** 3. Process Styles: Move <style> elements into the item's group, update selectors ***
          const styleElements = svgElement.getElementsByTagName('style');
          // Iterate backwards as we might remove/move elements
          for (let i = styleElements.length - 1; i >= 0; i--) {
              const styleElement = styleElements[i];
              if (styleElement.textContent) {
                  let cssText = styleElement.textContent;
                  // Update ID selectors (#oldId) within the CSS using the idMap
                  for (const [oldId, newId] of Object.entries(idMap)) {
                      // Use regex to safely replace #oldId selectors
                      // Lookbehind `(?<=#)` ensures we only match IDs starting with #
                      // Lookahead `(?![\\w-])` ensures we don't match partial IDs (e.g., #oldId-variant)
                      // Global flag `g` to replace all occurrences
                      // Need to escape special regex characters in oldId if necessary (less common for IDs)
                      const idSelectorRegex = new RegExp(`(?<=#)${oldId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`, 'g');
                      cssText = cssText.replace(idSelectorRegex, newId);
                  }
                  styleElement.textContent = cssText;
              }
              // Move the processed style element into the item's group <g>
              group.appendChild(styleElement);
              // Note: We moved the original node, no need to remove explicitly if iterating backwards
              // on a live list returned by getElementsByTagName (behavior can vary, but moving usually removes it)
              // If issues arise, explicitly remove: styleElement.parentNode.removeChild(styleElement);
          }


          // *** 4. Process remaining child nodes: Move them into the item's group ***
          // These nodes should already have updated IDs and references from step 1.
          // Iterate backwards when moving nodes from a live NodeList
          for (let i = svgElement.childNodes.length - 1; i >= 0; i--) {
            const node = svgElement.childNodes[i];
            const nodeName = node.nodeName.toLowerCase();

            // Skip defs and style elements as they were handled/moved above
            // Also skip the title and desc elements of the *source* svg root if desired
            if (node.nodeType === 1 && nodeName !== 'defs' && nodeName !== 'style' /* && nodeName !== 'title' && nodeName !== 'desc' */) {
              // Move the node into the group
              // Prepending ensures order is somewhat preserved relative to original source order
              // If appending: group.appendChild(node);
              group.insertBefore(node, group.firstChild);
            } else if (node.nodeType === 3 && node.textContent.trim()) {
                // Keep significant text nodes if any (less common directly under <svg>)
                group.insertBefore(node.cloneNode(true), group.firstChild); // Clone text nodes
            } else if (node.nodeType === 8) {
                // Keep comments if desired
                // group.insertBefore(node.cloneNode(true), group.firstChild); // Clone comments
            }
          }

          // *** Add the fully processed group (with transformed, ID-updated content) to the root SVG ***
          rootElement.appendChild(group);

        } else {
          // *** Non-SVG Image Embedding (using <image> and data URI) ***
          // This logic remains the same for non-SVG types
          core.info(`Embedding image for item ${item.id} using <image> tag`);
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', `item_${item.id}`); // Use item ID
          imageElement.setAttribute('x', String(item.x));
          imageElement.setAttribute('y', String(item.y));
          imageElement.setAttribute('width', String(item.width));
          imageElement.setAttribute('height', String(item.height));
          // The 'content' here is already a data URI prepared earlier
          imageElement.setAttribute('href', content); // Use 'href' for SVG 2, works in most modern renderers
          // imageElement.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', content); // For broader compatibility if needed
          // Preserve aspect ratio behavior (optional, default is 'defer')
          // imageElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');

          rootElement.appendChild(imageElement);
        }
      } catch (error) {
        // Log warning instead of failing the whole action for one item
        core.warning(`Error processing item ${item.id} (URL: ${item.url}): ${error.message}\n${error.stack || ''}`);
        // Optionally add a placeholder or skip the item
        const errorPlaceholder = rootSvg.createElement('g');
        errorPlaceholder.setAttribute('id', `error_item_${item.id}`);
        const errorRect = rootSvg.createElement('rect');
        errorRect.setAttribute('x', String(item.x));
        errorRect.setAttribute('y', String(item.y));
        errorRect.setAttribute('width', String(item.width));
        errorRect.setAttribute('height', String(item.height));
        errorRect.setAttribute('fill', 'red');
        errorRect.setAttribute('opacity', '0.3');
        const errorText = rootSvg.createElement('text');
        errorText.setAttribute('x', String(item.x + 5));
        errorText.setAttribute('y', String(item.y + 20));
        errorText.setAttribute('font-family', 'sans-serif');
        errorText.setAttribute('font-size', '12');
        errorText.setAttribute('fill', 'black');
        errorText.textContent = `Error loading ${item.id}`;
        errorPlaceholder.appendChild(errorRect);
        errorPlaceholder.appendChild(errorText);
        rootElement.appendChild(errorPlaceholder);
      }
    }

    // Serialize the merged SVG
    let mergedSvgString = serializer.serializeToString(rootSvg);

    // Add XML declaration if missing (good practice)
    if (!mergedSvgString.startsWith('<?xml')) {
        mergedSvgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + mergedSvgString;
    }

    // Write merged SVG to temporary file (optional, for debugging)
    // await fs.writeFile('merged_unoptimized.svg', mergedSvgString);

    // Optimize SVG with SVGO but preserve animations and structure
    core.info('Optimizing SVG with SVGO...');
    const svgoOptions = {
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        // Preserve structure and attributes potentially needed for animations/layout
                        removeViewBox: false, // Keep viewBox on root
                        cleanupIDs: false, // IMPORTANT: Keep IDs, we handled uniqueness manually
                        removeUselessDefs: false, // Defs might be used by scripts or complex animations
                        inlineStyles: false, // Keep <style> blocks, important for complex CSS/animations
                        minifyStyles: false, // Avoid breaking complex CSS selectors/animations
                        removeUnknownsAndDefaults: {
                            unknownContent: false, // Keep unknown elements/attributes
                            unknownAttrs: false,
                            keepDataAttrs: true, // Keep data-* attributes
                            keepAriaAttrs: true, // Keep aria-* attributes
                        },
                        removeHiddenElems: false, // Hidden elements might be revealed by animation/interaction
                        removeEmptyContainers: false, // Empty groups might be placeholders or used by scripts
                        moveElemsAttrsToGroup: false, // Avoid restructuring
                        moveGroupAttrsToElems: false, // Avoid restructuring
                        collapseGroups: false, // Keep group structure, important for transforms and styles
                        mergePaths: false, // Merging paths can break structure/animations
                        convertShapeToPath: false, // Keep original shapes if possible
                        convertPathData: { // Be conservative with path optimization
                            makeArcs: false,
                            straightCurves: false,
                            lineCurves: false,
                            curveSmoothShorthands: false,
                            floatPrecision: 3,
                            transformPrecision: 5,
                        },
                        removeNonInheritableGroupAttrs: false, // Keep attributes on groups
                        removeRasterImages: false, // Keep raster images embedded via <image>
                        // sortAttrs: false, // Keep attribute order (can matter for some parsers/renderers)
                        // removeDimensions: true, // Keep width/height on root SVG
                    },
                },
            },
            // Add other specific plugins if needed
            'removeComments',
            'removeMetadata',
            // 'removeXMLProcInst', // Keep XML declaration added earlier
        ],
        // Important for preserving xmlns:xlink etc. if used by animations/hrefs
        multipass: true, // Run multiple passes for better optimization
        js2svg: {
            indent: 2, // Pretty output
            pretty: true,
        },
    };

    const optimizedSvg = optimize(mergedSvgString, svgoOptions);

    if (optimizedSvg.error) {
        core.warning(`SVGO optimization failed: ${optimizedSvg.error}`);
        // Fallback to using the unoptimized SVG
        await fs.writeFile('README.svg', mergedSvgString);
        core.warning('Using unoptimized SVG due to SVGO error.');
    } else {
        await fs.writeFile('README.svg', optimizedSvg.data);
        core.info('SVG optimized successfully.');
    }


    // --- Git Commit and Push ---
    core.info('Configuring Git...');
    await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
    await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

    core.info('Checking for changes in README.svg...');
    // Use 'git status --porcelain' for a more reliable check
    let gitStatusOutput = '';
    const options = {
        listeners: {
            stdout: (data) => { gitStatusOutput += data.toString(); }
        },
        ignoreReturnCode: true // Don't fail the action if status returns non-zero (e.g., untracked file)
    };
    await exec.exec('git', ['status', '--porcelain', 'README.svg'], options);

    // Check if README.svg is modified or untracked/new
    if (gitStatusOutput.includes('README.svg')) {
        core.info('Changes detected in README.svg. Committing and pushing...');
        await exec.exec('git', ['add', 'README.svg']);
        // Check diff --staged to see if there are actual changes staged
        const diffExitCode = await exec.exec('git', ['diff', '--staged', '--quiet'], { ignoreReturnCode: true });

        if (diffExitCode !== 0) {
            await exec.exec('git', ['commit', '-m', 'ci: update profile svg']);

            const repository = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
            // *** Use GITHUB_HEAD_REF for PRs, GITHUB_REF_NAME for pushes ***
            const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
            if (!branch) {
                core.setFailed('Could not determine branch name from GITHUB_HEAD_REF or GITHUB_REF_NAME');
                return;
            }
            core.info(`Pushing changes to branch: ${branch}`);
            await exec.exec('git', ['push', repository, `HEAD:${branch}`]);

            core.info('Successfully committed and pushed updated README.svg');
        } else {
             core.info('README.svg added to staging, but no effective changes detected. Skipping commit.');
             // Optional: Reset the staging area if no commit is made
             await exec.exec('git', ['reset', 'HEAD', 'README.svg']);
        }
    } else {
      core.info('No changes detected in README.svg. Nothing to commit.');
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}\n${error.stack}`);
  }
}

run();

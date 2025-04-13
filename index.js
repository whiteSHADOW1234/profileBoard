import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from 'xmldom';

// Helper function to update ID references in the SVG content
function updateReferences(element, oldId, newId, idPrefix) {
    const prefixedOldId = idPrefix + oldId; // Use the same prefixing logic as when creating new IDs

    // Process url(#id) references in style attributes
    if (element.hasAttribute('style')) {
        const style = element.getAttribute('style');
        // Check for both original and potentially already prefixed IDs if nested
        if (style.includes(`url(#${oldId})`)) {
            element.setAttribute('style', style.replace(new RegExp(`url\\(#${oldId}\\)`, 'g'), `url(#${newId})`));
        } else if (style.includes(`url(#${prefixedOldId})`)) {
             element.setAttribute('style', style.replace(new RegExp(`url\\(#${prefixedOldId}\\)`, 'g'), `url(#${newId})`));
        }
    }

    // Process href and xlink:href attributes
    const hrefAttr = element.getAttribute('href');
    const xlinkHrefAttr = element.getAttribute('xlink:href');

    if (hrefAttr === `#${oldId}` || hrefAttr === `#${prefixedOldId}`) {
        element.setAttribute('href', `#${newId}`);
    }
    if (xlinkHrefAttr === `#${oldId}` || xlinkHrefAttr === `#${prefixedOldId}`) {
        element.setAttribute('xlink:href', `#${newId}`);
    }

    // Process fill and stroke attributes referencing URLs
    const fillAttr = element.getAttribute('fill');
    const strokeAttr = element.getAttribute('stroke');

    if (fillAttr === `url(#${oldId})` || fillAttr === `url(#${prefixedOldId})`) {
        element.setAttribute('fill', `url(#${newId})`);
    }
    if (strokeAttr === `url(#${oldId})` || strokeAttr === `url(#${prefixedOldId})`) {
        element.setAttribute('stroke', `url(#${newId})`);
    }

    // Recursively process child elements
    for (let i = 0; i < element.childNodes.length; i++) {
        const child = element.childNodes[i];
        if (child.nodeType === 1) { // ELEMENT_NODE
            updateReferences(child, oldId, newId, idPrefix);
        }
    }
}


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

    // Initialize parser and serializer
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

    // --- Start Change 1: Initialize dynamic bounds ---
    let overallMinX = Infinity;
    let overallMinY = Infinity;
    let overallMaxX = -Infinity;
    let overallMaxY = -Infinity;
    let itemsProcessed = 0; // Keep track if any items were successfully processed
    // --- End Change 1 ---

    // Create the root SVG structure (without dimensions initially)
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>`,
      'image/svg+xml'
    );
    const rootElement = rootSvg.documentElement;
    let rootDefs = null; // Initialize root defs element reference

    // Process each layout item
    for (const item of layout) {
      try {
        // --- Start Change 2: Validate item structure ---
        if (typeof item.x !== 'number' || typeof item.y !== 'number' || typeof item.width !== 'number' || typeof item.height !== 'number' || typeof item.url !== 'string') {
            core.warning(`Skipping invalid layout item (missing x, y, width, height, or url): ${JSON.stringify(item)}`);
            continue; // Skip this item
        }
        // --- End Change 2 ---

        let content;
        let isInlineSvg = false;

        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);

          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }

          const contentType = response.headers.get('content-type');

          // Check if the content is SVG based on response headers or explicit type
          if ((contentType && contentType.includes('svg')) || item.type === 'svg') {
            content = await response.text();
            isInlineSvg = true;
          } else {
            // For images, convert to data URI
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || 'image/png'; // Default to png if not specified
            content = `data:${mimeType};base64,${base64}`;
          }
        } else if (item.url.startsWith('blob:')) {
          // Local file - read from disk (keeping the blob: prefix for compatibility)
          const filePath = item.url.substring(5); // Remove 'blob:' prefix
          const imagePath = path.join('images', filePath);

          core.info(`Reading local file: ${imagePath}`);

          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }

          const fileContent = await fs.readFile(assetMap.get(imagePath));

          if (item.type === 'svg') {
            content = fileContent.toString('utf8');
            isInlineSvg = true;
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            // Determine mime type more robustly
            const ext = path.extname(imagePath).toLowerCase().substring(1);
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`; // Default to png
            content = `data:${mimeType};base64,${base64}`;
          }
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;

          core.info(`Reading local file: ${imagePath}`);

          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }

          const fileContent = await fs.readFile(assetMap.get(imagePath));

          if (item.type === 'svg') {
            content = fileContent.toString('utf8');
            isInlineSvg = true;
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
             // Determine mime type more robustly
            const ext = path.extname(imagePath).toLowerCase().substring(1);
            const mimeType = `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}`; // Default to png
            content = `data:${mimeType};base64,${base64}`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }

        // Process content based on type
        if (isInlineSvg) {
          // Check if the content starts with XML declaration and remove it if needed
          if (content.trim().startsWith('<?xml')) {
            content = content.substring(content.indexOf('<svg'));
          }

          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;

          if (!svgElement || svgElement.nodeName !== 'svg') {
            throw new Error(`Invalid SVG content from ${item.url}`);
          }

          // Get SVG dimensions for scaling
          let sourceSvgWidth, sourceSvgHeight;
          let viewBox = null;

          if (svgElement.hasAttribute('viewBox')) {
            viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/).map(Number);
            if (viewBox.length === 4 && viewBox[2] > 0 && viewBox[3] > 0) {
                sourceSvgWidth = viewBox[2];
                sourceSvgHeight = viewBox[3];
            }
          }

          // Use width/height attributes if viewBox is missing or invalid
          if ((!sourceSvgWidth || !sourceSvgHeight) && svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
             const wAttr = svgElement.getAttribute('width');
             const hAttr = svgElement.getAttribute('height');
             // Allow unitless numbers or pixel values
             const wMatch = wAttr.match(/^(\d*\.?\d+)(px)?$/);
             const hMatch = hAttr.match(/^(\d*\.?\d+)(px)?$/);
             if (wMatch && hMatch) {
                sourceSvgWidth = parseFloat(wMatch[1]);
                sourceSvgHeight = parseFloat(hMatch[1]);
             }
          }

          // If dimensions still not found, use the layout item's dimensions as the source dimensions
          if (!sourceSvgWidth || sourceSvgWidth <= 0) {
              sourceSvgWidth = item.width;
              core.warning(`Could not determine source width for SVG from ${item.url}. Using layout width: ${item.width}`);
          }
          if (!sourceSvgHeight || sourceSvgHeight <= 0) {
              sourceSvgHeight = item.height;
              core.warning(`Could not determine source height for SVG from ${item.url}. Using layout height: ${item.height}`);
          }


          // Create a group element to contain the SVG content with proper positioning
          const group = rootSvg.createElement('g');

          // Determine scaling
          const scaleX = item.width / sourceSvgWidth;
          const scaleY = item.height / sourceSvgHeight;

          // Apply transformation for position and scale
          // Adjust translation if the source SVG had a viewBox offset
          const translateX = item.x - (viewBox ? viewBox[0] * scaleX : 0);
          const translateY = item.y - (viewBox ? viewBox[1] * scaleY : 0);

          let transform = `translate(${translateX}, ${translateY})`;
          if (scaleX !== 1 || scaleY !== 1) {
            transform += ` scale(${scaleX}, ${scaleY})`;
          }
          group.setAttribute('transform', transform);

          // Extract and copy all attributes from the source SVG except dimensional/positional ones
          const attributesToExclude = ['width', 'height', 'viewBox', 'x', 'y', 'xmlns', 'version', 'xmlns:xlink'];
          for (let i = 0; i < svgElement.attributes.length; i++) {
            const attr = svgElement.attributes[i];
            if (!attributesToExclude.includes(attr.name.toLowerCase())) { // Use lowercase for case-insensitivity
              group.setAttribute(attr.name, attr.value);
            }
          }

          // Copy all defs to the root SVG to maintain references
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            // Create a master defs in the root SVG if it doesn't exist
            if (!rootDefs) {
              rootDefs = rootSvg.createElement('defs');
              // Insert defs as the first child for clarity and convention
              if (rootElement.firstChild) {
                  rootElement.insertBefore(rootDefs, rootElement.firstChild);
              } else {
                  rootElement.appendChild(rootDefs);
              }
            }

            // Copy all items from source defs to root defs
            for (let i = 0; i < defsElements.length; i++) {
              const sourceDefs = defsElements[i];
              // Generate a unique prefix for IDs within this item
              const itemIdentifier = item.id || `item${itemsProcessed}`; // Use item.id if available, otherwise index
              const idPrefix = `${itemIdentifier.replace(/[^a-zA-Z0-9_]/g, '_')}_def${i}_`; // Make prefix more robust

              // Process each child of defs
              for (let j = 0; j < sourceDefs.childNodes.length; j++) {
                const node = sourceDefs.childNodes[j];
                if (node.nodeType === 1) { // ELEMENT_NODE
                    const clonedNode = node.cloneNode(true);
                    let originalId = null;
                    let newId = null;

                    if (clonedNode.hasAttribute('id')) {
                        originalId = clonedNode.getAttribute('id');
                        newId = idPrefix + originalId;
                        clonedNode.setAttribute('id', newId);
                    }

                    rootDefs.appendChild(clonedNode);

                    // Update references within the *cloned node itself* if it references other prefixed IDs
                    if (newId) {
                        updateReferences(clonedNode, originalId, newId, idPrefix);
                    }

                    // Update references within the main SVG content *being added* to point to the new prefixed ID in rootDefs
                    if (originalId && newId) {
                        updateReferences(svgElement, originalId, newId, idPrefix); // Update references in the source before cloning children
                    }
                } else if (node.nodeType === 3 && node.nodeValue.trim()) { // TEXT_NODE (e.g., inside <style>)
                    // Clone text nodes too, especially within <style> in <defs>
                    rootDefs.appendChild(node.cloneNode(true));
                } else if (node.nodeType === 8) { // COMMENT_NODE
                    // Optionally preserve comments
                    rootDefs.appendChild(node.cloneNode(true));
                }
              }
            }
          }

          // Copy all children of the source SVG to our group (except defs which we already processed)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            // Skip defs, and also skip empty text nodes
            if (node.nodeName !== 'defs' && !(node.nodeType === 3 && !node.nodeValue.trim())) {
              group.appendChild(node.cloneNode(true));
            }
          }

          rootElement.appendChild(group);

        } else {
          // Handle image elements
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('x', String(item.x)); // Ensure attributes are strings
          imageElement.setAttribute('y', String(item.y));
          imageElement.setAttribute('width', String(item.width));
          imageElement.setAttribute('height', String(item.height));
          imageElement.setAttribute('href', content); // Use href for SVG 1.1+, xlink:href is legacy

          rootElement.appendChild(imageElement);
        }

        // --- Start Change 3: Update overall bounds ---
        overallMinX = Math.min(overallMinX, item.x);
        overallMinY = Math.min(overallMinY, item.y);
        overallMaxX = Math.max(overallMaxX, item.x + item.width);
        overallMaxY = Math.max(overallMaxY, item.y + item.height);
        itemsProcessed++;
        // --- End Change 3 ---

      } catch (error) {
        core.warning(`Error processing item ${item.id ? `(id: ${item.id})` : ''} from ${item.url}: ${error.message}`);
        // Continue with other items rather than failing completely
      }
    }

    // --- Start Change 4: Calculate final dimensions and set SVG attributes ---
    let finalMinX, finalMinY, finalWidth, finalHeight;

    if (itemsProcessed === 0) {
        // Handle the case with no items or only failed items
        finalMinX = 0;
        finalMinY = 0;
        finalWidth = 100; // Default size
        finalHeight = 100; // Default size
        core.warning("Layout was empty or all items failed to process. Using default SVG bounds (0 0 100 100).");
    } else {
        finalMinX = overallMinX;
        finalMinY = overallMinY;
        finalWidth = overallMaxX - overallMinX;
        finalHeight = overallMaxY - overallMinY;

        // Ensure width/height are not zero or negative if items have zero dimensions or overlap perfectly
        if (finalWidth <= 0) finalWidth = 1;
        if (finalHeight <= 0) finalHeight = 1;
    }

    // Set the calculated dimensions and viewBox on the root SVG element
    rootElement.setAttribute('width', String(finalWidth));
    rootElement.setAttribute('height', String(finalHeight));
    rootElement.setAttribute('viewBox', `${finalMinX} ${finalMinY} ${finalWidth} ${finalHeight}`);
    // --- End Change 4 ---


    // Serialize the merged SVG
    let mergedSvgString = serializer.serializeToString(rootSvg);

    // Write merged SVG to temporary file (optional, for debugging)
    // await fs.writeFile('merged_debug.svg', mergedSvgString);

    // Optimize SVG with SVGO but preserve animations and structure
    core.info('Optimizing SVG with SVGO...');
    const svgoOptions = {
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        // Preserve structure and attributes needed for layout and animations
                        removeViewBox: false, // Keep the calculated viewBox
                        cleanupIDs: false, // Keep our prefixed IDs
                        collapseGroups: false, // Keep groups for positioning/scaling
                        moveElemsAttrsToGroup: false,
                        moveGroupAttrsToElems: false,
                        mergePaths: false, // Merging can break complex SVGs
                        convertShapeToPath: { convertArcs: true }, // Usually safe, convertArcs helps consistency
                        removeUnknownsAndDefaults: { // Be careful with defaults
                            keepRoleAttr: true,
                            keepDataAttrs: true, // Keep data-* attributes
                        },
                        removeUselessDefs: false, // Defs might be referenced dynamically or by CSS
                        removeHiddenElems: false, // Might be used for animation states
                        removeEmptyAttrs: false, // Empty attrs might be placeholders
                        removeEmptyContainers: false, // Keep structure
                        removeNonInheritableGroupAttrs: false, // Keep attributes like 'transform'
                        // Animation related preservation
                        inlineStyles: false, // Keep <style> elements if present
                        minifyStyles: false, // Don't minify <style> content
                    },
                },
            },
            // Add specific plugins if needed, e.g., removeComments, removeMetadata
            'removeComments',
            'removeMetadata',
            // 'sortAttrs', // Generally safe
        ],
        // Important for preserving xmlns:xlink if used by older SVGs/tools
        multipass: true, // Run multiple passes for better optimization
    };

    const optimizedSvg = optimize(mergedSvgString, svgoOptions);

    if (optimizedSvg.error) {
        core.warning(`SVGO optimization failed: ${optimizedSvg.error}`);
        // Fallback to using the unoptimized SVG string if optimization fails
        await fs.writeFile('README.svg', mergedSvgString);
        core.warning('Using unoptimized SVG due to SVGO error.');
    } else {
        await fs.writeFile('README.svg', optimizedSvg.data);
    }


    // Configure git user
    await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']); // Standard bot name
    await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']); // Standard bot email

    // Check if there are changes to commit
    // Use 'git status --porcelain' for a more reliable check
    let gitStatusOutput = '';
    const options = { listeners: { stdout: (data) => { gitStatusOutput += data.toString(); } } };
    await exec.exec('git', ['status', '--porcelain', 'README.svg'], options);


    if (gitStatusOutput.includes('README.svg')) {
      // Changes detected, commit and push
      core.info('Changes detected in README.svg. Committing and pushing...');
      await exec.exec('git', ['add', 'README.svg']);
      // Use a standard commit message format
      await exec.exec('git', ['commit', '-m', 'ci: update profile SVG [skip ci]']); // Add [skip ci] to prevent triggering workflows again

      // Set up the remote repository URL securely
      const context = github.context;
      const repositoryUrl = `https://x-access-token:${token}@github.com/${context.repo.owner}/${context.repo.repo}.git`;
      const branch = context.ref.startsWith('refs/heads/') ? context.ref.substring(11) : 'main'; // Get current branch or default to main

      await exec.exec('git', ['push', repositoryUrl, `HEAD:${branch}`]); // Push to the current branch

      core.info(`Successfully committed and pushed updated README.svg to branch ${branch}`);
    } else {
      core.info('No changes detected in README.svg. Nothing to commit.');
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}\n${error.stack}`);
  }
}

run();

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
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

    // Create a collection to store animation-related elements
    const defs = rootSvg.createElement('defs');
    rootElement.appendChild(defs);

    // Track used IDs to prevent conflicts
    const usedIds = new Set();

    // Helper function to make IDs unique
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

    // Helper function to update ID references in attributes
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


    // Recursively process an element and its children to update ID references
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
        let svgContent; // Will hold raw SVG string or data URI for non-SVG
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
            svgContent = await response.text();
            // Handle JSON responses containing SVG
            if (contentType?.includes('application/json')) {
              try {
                const jsonData = JSON.parse(svgContent);
                if (jsonData.svg) svgContent = jsonData.svg;
                else if (jsonData.data) svgContent = jsonData.data;
                else if (jsonData.content) svgContent = jsonData.content;
                else { /* Could not find SVG in JSON */ }
              } catch (e) { core.info(`Response looked like JSON but couldn't extract SVG: ${e.message}`); }
            }
            // Handle SVG provided as a data URI
            if (svgContent.startsWith('data:image/svg+xml;base64,')) {
              const base64Data = svgContent.replace('data:image/svg+xml;base64,', '');
              svgContent = Buffer.from(base64Data, 'base64').toString('utf8');
            }
            // Basic validation
            if (!svgContent.trim().startsWith('<svg') && !svgContent.trim().startsWith('<?xml')) {
              throw new Error(`Content from ${item.url} does not appear to be valid SVG.`);
            }
          } else { // Non-SVG remote content
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || `image/${item.type}` || 'image/png'; // Guess mime type if needed
            svgContent = `data:${mimeType};base64,${base64}`; // Create data URI
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
            svgContent = fileBuffer.toString('utf8'); // Raw SVG text
             // Basic validation
             if (!svgContent.trim().startsWith('<svg') && !svgContent.trim().startsWith('<?xml')) {
              throw new Error(`Content from ${imagePath} does not appear to be valid SVG.`);
            }
          } else { // Non-SVG local file
            const base64 = fileBuffer.toString('base64');
            // Infer mime type from extension if possible
            const ext = path.extname(imagePath).toLowerCase().substring(1);
            const mimeType = `image/${ext || item.type || 'png'}`;
            svgContent = `data:${mimeType};base64,${base64}`; // Create data URI
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }

        // --- Process Content ---
        if (isSvgType) {
          // *** SVG Inlining Logic ***
          core.info(`Inlining SVG for item ${item.id}`);
          const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;

          // Check for parser errors
          const parseErrors = svgElement.getElementsByTagName('parsererror');
          if (parseErrors.length > 0) {
              throw new Error(`Error parsing SVG content for item ${item.id}: ${parseErrors[0].textContent}`);
          }

          // Create a group for this SVG item
          const group = rootSvg.createElement('g');
          group.setAttribute('id', `item_${item.id}`); // Use item ID for the group

          // --- Calculate Scaling ---
          let svgIntrinsicWidth, svgIntrinsicHeight;
          if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
            svgIntrinsicWidth = parseFloat(svgElement.getAttribute('width'));
            svgIntrinsicHeight = parseFloat(svgElement.getAttribute('height'));
          } else if (svgElement.hasAttribute('viewBox')) {
            const viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/);
            if (viewBox.length === 4) {
                svgIntrinsicWidth = parseFloat(viewBox[2]);
                svgIntrinsicHeight = parseFloat(viewBox[3]);
            }
          }
          // Fallback if dimensions are unknown, use target dimensions (no scaling)
          if (isNaN(svgIntrinsicWidth) || svgIntrinsicWidth <= 0) svgIntrinsicWidth = item.width;
          if (isNaN(svgIntrinsicHeight) || svgIntrinsicHeight <= 0) svgIntrinsicHeight = item.height;


          let transform = `translate(${item.x}, ${item.y})`;
          if (svgIntrinsicWidth !== item.width || svgIntrinsicHeight !== item.height) {
            const scaleX = item.width / svgIntrinsicWidth;
            const scaleY = item.height / svgIntrinsicHeight;
            // Append scale to transform
            transform += ` scale(${scaleX}, ${scaleY})`;
          }
          group.setAttribute('transform', transform);


          // --- Process IDs, Defs, Styles, and Content ---
          const idMap = {}; // Map to track old ID -> new ID for this item

          // 1. Process Defs: Move children of <defs> to the root <defs>, updating IDs
          const svgDefs = svgElement.getElementsByTagName('defs');
          for (let i = 0; i < svgDefs.length; i++) {
            const defElement = svgDefs[i];
            // Iterate backwards when removing/moving nodes
            for (let j = defElement.childNodes.length - 1; j >= 0; j--) {
              const defChild = defElement.childNodes[j];
              if (defChild.nodeType === 1) { // Element node
                const clonedDef = defChild.cloneNode(true);
                // Process IDs within the cloned def element *before* adding to root defs
                processElementIds(clonedDef, item.id, idMap);
                defs.appendChild(clonedDef);
              }
            }
            // Optionally remove the original <defs> element after processing its children
            // defElement.parentNode.removeChild(defElement);
          }

          // 2. Process Styles: Move <style> elements, update selectors
          const styleElements = svgElement.getElementsByTagName('style');
          for (let i = styleElements.length - 1; i >= 0; i--) {
              const styleElement = styleElements[i];
              const clonedStyle = styleElement.cloneNode(true);
              if (clonedStyle.textContent) {
                  let cssText = clonedStyle.textContent;
                  // Update ID selectors (#oldId) within the CSS
                  for (const [oldId, newId] of Object.entries(idMap)) {
                      // Use regex to avoid replacing parts of longer IDs or class names
                      const idSelectorRegex = new RegExp(`#${oldId}(?![\\w-])`, 'g'); // #oldId not followed by word char or hyphen
                      cssText = cssText.replace(idSelectorRegex, `#${newId}`);
                  }
                  clonedStyle.textContent = cssText;
              }
              // Add processed style to the item's group
              group.appendChild(clonedStyle);
              // Optionally remove the original <style> element
              // styleElement.parentNode.removeChild(styleElement);
          }


          // 3. Process remaining child nodes: Clone, update IDs, and append to group
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            const nodeName = node.nodeName.toLowerCase();

            // Skip defs and style elements as they were handled above
            if (node.nodeType === 1 && nodeName !== 'defs' && nodeName !== 'style') {
              const clonedNode = node.cloneNode(true);
              // Process IDs recursively within the cloned node and its descendants
              processElementIds(clonedNode, item.id, idMap);
              group.appendChild(clonedNode);
            } else if (node.nodeType === 3 && node.textContent.trim()) {
                // Keep significant text nodes if any (less common directly under <svg>)
                group.appendChild(node.cloneNode(true));
            } else if (node.nodeType === 8) {
                // Keep comments if desired
                // group.appendChild(node.cloneNode(true));
            }
          }

          // Add the fully processed group to the root SVG
          rootElement.appendChild(group);

        } else {
          // *** Non-SVG Image Embedding (using <image> and data URI) ***
          core.info(`Embedding image for item ${item.id} using <image> tag`);
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', `item_${item.id}`); // Use item ID
          imageElement.setAttribute('x', String(item.x));
          imageElement.setAttribute('y', String(item.y));
          imageElement.setAttribute('width', String(item.width));
          imageElement.setAttribute('height', String(item.height));
          // The svgContent here is already a data URI prepared earlier
          imageElement.setAttribute('href', svgContent);
          // Preserve aspect ratio behavior (optional, default is 'defer')
          // imageElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');

          rootElement.appendChild(imageElement);
        }
      } catch (error) {
        // Log warning instead of failing the whole action for one item
        core.warning(`Error processing item ${item.id} (URL: ${item.url}): ${error.message}`);
        // Optionally add a placeholder or skip the item
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
                        removeViewBox: false, // Keep viewBox
                        cleanupIDs: false, // Keep IDs, we handled uniqueness
                        removeUselessDefs: false, // Defs might be used by scripts or complex animations
                        inlineStyles: false, // Keep <style> blocks, important for complex CSS/animations
                        minifyStyles: false, // Avoid breaking complex CSS selectors/animations
                        removeUnknownsAndDefaults: {
                            // Keep unknown elements/attributes, might be needed by scripts/future SVG specs
                            unknownContent: false,
                            unknownAttrs: false,
                            // Keep default attributes if they might be targeted by CSS/SMIL
                            keepDataAttrs: true, // Keep data-* attributes
                            keepAriaAttrs: true, // Keep aria-* attributes
                        },
                        removeHiddenElems: false, // Hidden elements might be revealed by animation/interaction
                        removeEmptyContainers: false, // Empty groups might be placeholders or used by scripts
                        moveElemsAttrsToGroup: false, // Avoid restructuring
                        moveGroupAttrsToElems: false, // Avoid restructuring
                        collapseGroups: false, // Keep group structure
                        mergePaths: false, // Merging paths can break structure/animations
                        convertShapeToPath: false, // Keep original shapes if possible
                        convertPathData: { // Be conservative with path optimization
                            makeArcs: false, // Arcs can be tricky
                            straightCurves: false, // Avoid minor visual changes
                            lineCurves: false,
                            curveSmoothShorthands: false,
                            floatPrecision: 3, // Reasonable precision
                            transformPrecision: 5,
                        },
                        removeNonInheritableGroupAttrs: false, // Keep attributes on groups
                        removeRasterImages: false, // Keep raster images embedded via <image>
                        // sortAttrs: false, // Keep attribute order (can matter for some parsers/renderers)
                        // removeDimensions: true, // Keep width/height on root SVG
                    },
                },
            },
            // Add other specific plugins if needed, e.g., removeComments, removeMetadata
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
            const branch = process.env.GITHUB_REF.split('/').pop(); // Get current branch name
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

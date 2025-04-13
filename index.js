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

    // Define the specific background dimensions 
    const bgMinX = -150;
    const bgMaxX = 1050;
    const bgMinY = 0;
    const bgMaxY = 600;
    const bgWidth = bgMaxX - bgMinX;
    const bgHeight = bgMaxY - bgMinY;

    // Calculate SVG viewBox based on the background dimensions
    // This ensures the entire background is visible
    const viewBoxMinX = bgMinX;
    const viewBoxMinY = bgMinY;
    const viewBoxWidth = bgWidth;
    const viewBoxHeight = bgHeight;

    // Create the root SVG with calculated viewBox and dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
            width="${viewBoxWidth}" height="${viewBoxHeight}" 
            viewBox="${viewBoxMinX} ${viewBoxMinY} ${viewBoxWidth} ${viewBoxHeight}">
      </svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    let rootDefs = null; // Initialize root defs element reference

    // Add white background as the first element
    // This background covers exactly the specified range
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', bgMinX.toString());
    backgroundRect.setAttribute('y', bgMinY.toString());
    backgroundRect.setAttribute('width', bgWidth.toString());
    backgroundRect.setAttribute('height', bgHeight.toString());
    backgroundRect.setAttribute('fill', 'white');
    rootElement.appendChild(backgroundRect);
    
    let itemsProcessed = 0; // Keep track if any items were successfully processed

    // Process each layout item
    for (const item of layout) {
      try {
        // Validate item structure
        if (typeof item.x !== 'number' || typeof item.y !== 'number' || 
            typeof item.width !== 'number' || typeof item.height !== 'number' || 
            typeof item.url !== 'string') {
            core.warning(`Skipping invalid layout item (missing x, y, width, height, or url): ${JSON.stringify(item)}`);
            continue; // Skip this item
        }

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
          // Parse SVG content
          // Check if the content starts with XML declaration and remove it if needed
          if (content.trim().startsWith('<?xml')) {
            content = content.substring(content.indexOf('?>') + 2).trim();
          }
          
          // Make sure content starts with <svg tag
          if (!content.trim().startsWith('<svg')) {
            throw new Error(`Invalid SVG content from ${item.url}: Does not start with <svg> tag`);
          }

          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;

          // Determine source SVG dimensions
          let sourceSvgWidth = null;
          let sourceSvgHeight = null;
          let viewBox = null;

          // Try to get dimensions from viewBox
          if (svgElement.hasAttribute('viewBox')) {
            viewBox = svgElement.getAttribute('viewBox')
              .split(/[\s,]+/) // Split by whitespace or commas
              .map(parseFloat); // Convert to numbers

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
                }
              }
            }
          }

          // Copy all child elements excluding defs (those were already processed)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName.toLowerCase() !== 'defs') {
              group.appendChild(node.cloneNode(true));
            }
          }

          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('x', item.x.toString());
          imageElement.setAttribute('y', item.y.toString());
          imageElement.setAttribute('width', item.width.toString());
          imageElement.setAttribute('height', item.height.toString());
          imageElement.setAttribute('href', content);
          
          rootElement.appendChild(imageElement);
        }

        itemsProcessed++;
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }

    if (itemsProcessed === 0) {
      core.setFailed('No valid layout items were processed. Check your layout JSON and asset files.');
      return;
    }
    
    // Serialize the merged SVG
    const mergedSvgString = serializer.serializeToString(rootSvg);
    
    // Write merged SVG to temporary file
    await fs.writeFile('merged.svg', mergedSvgString);
    
    // Optimize SVG with SVGO but preserve animations
    core.info('Optimizing SVG with SVGO...');
    const optimizedSvg = optimize(mergedSvgString, {
      multipass: true,
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              // Disable plugins that might break animations or layout
              removeViewBox: false,
              removeHiddenElems: false,
              removeUselessDefs: false,
              convertShapeToPath: false,
              moveElemsAttrsToGroup: false,
              moveGroupAttrsToElems: false,
              collapseGroups: false,
              convertPathData: false,
              removeEmptyAttrs: false,
              removeEmptyContainers: false,
              mergePaths: false,
              removeUnknownsAndDefaults: false,
              removeNonInheritableGroupAttrs: false,
              // Critical for animations
              inlineStyles: false,
              minifyStyles: false,
              cleanupIDs: false
            },
          },
        },
      ],
    });
    
    // Write optimized SVG to README.svg
    await fs.writeFile('README.svg', optimizedSvg.data);
    
    // Configure git user
    await exec.exec('git', ['config', 'user.name', 'GitHub Action']);
    await exec.exec('git', ['config', 'user.email', 'action@github.com']);
    
    // Check if there are changes to commit
    const { exitCode } = await exec.exec('git', ['diff', '--quiet', 'README.svg'], { ignoreReturnCode: true });
    
    if (exitCode !== 0) {
      // Changes detected, commit and push
      await exec.exec('git', ['add', 'README.svg']);
      await exec.exec('git', ['commit', '-m', 'ci: update merged profile SVG']);
      
      // Set up the remote repository
      const repository = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
      await exec.exec('git', ['push', repository]);
      
      core.info('Successfully committed and pushed updated README.svg');
    } else {
      core.info('No changes to commit');
    }
    
  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
import * as core from '@actions/core';
import * as glob from '@actions/glob';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch'; 
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from 'xmldom';

/**
 * Fetches content from a URL with retry logic
 * @param {string} url The URL to fetch
 * @param {number} maxRetries Maximum number of retry attempts
 * @param {number} retryDelay Delay between retries in milliseconds
 * @returns {Promise<string>} The fetched text content
 */
async function fetchWithRetry(url, maxRetries = 3, retryDelay = 1000) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    core.info(`Attempt ${attempt}/${maxRetries} to fetch ${url}`);
    
    try {
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} - ${response.statusText}`);
      }
      
      const content = await response.text();
      return content;
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        // Wait before next retry
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw lastError || new Error(`Failed to fetch ${url} after ${maxRetries} attempts`);
}

async function run() {
  try {
    // Get inputs from action
    const layoutInput = core.getInput('layout', { required: true });
    const assetsInput = core.getInput('assets', { required: false }) || 'images/*.svg';

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

    // Initialize XML parsers
    const parser = new DOMParser();
    const serializer = new XMLSerializer();

    // Create a map of local asset files
    const assetMap = new Map();
    const assetPatterns = assetsInput.split(',').map(pattern => pattern.trim());

    core.info('Searching for local asset files...');
    for (const pattern of assetPatterns) {
      const globber = await glob.create(pattern);
      const files = await globber.glob();

      for (const file of files) {
        const relativePath = path.relative(process.cwd(), file).replace(/\\/g, '/');
        core.info(`Found asset: ${relativePath} -> ${file}`);
        assetMap.set(relativePath, file);
      }
    }
    core.info(`Found ${assetMap.size} local asset(s).`);

    // Set canvas dimensions for the final SVG
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;

    // Create the root SVG element
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" 
            width="${svgWidth}" height="${svgHeight}" 
            viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    const rootElement = rootSvg.documentElement;

    // Add white background
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', minX.toString());
    backgroundRect.setAttribute('y', minY.toString());
    backgroundRect.setAttribute('width', svgWidth.toString());
    backgroundRect.setAttribute('height', svgHeight.toString());
    backgroundRect.setAttribute('fill', 'white');
    rootElement.appendChild(backgroundRect);

    // Create a global defs element
    const defs = rootSvg.createElement('defs');
    rootElement.insertBefore(defs, rootElement.firstChild ? rootElement.firstChild.nextSibling : null);

    // Track used IDs to prevent conflicts
    const usedIds = new Set();

    // Helper function to make IDs unique
    function makeIdUnique(id, itemId) {
      if (!id) return null;
      
      const safeItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const newIdBase = `${safeItemId}_${id}`;
      
      let finalId = newIdBase;
      let counter = 1;
      
      while (usedIds.has(finalId)) {
        finalId = `${newIdBase}_${counter++}`;
      }
      
      usedIds.add(finalId);
      return finalId;
    }

    // Helper function to update ID references
    function updateIdReferences(element, oldId, newId) {
      if (!element || element.nodeType !== 1 || !oldId || !newId || oldId === newId) return;

      const escapedOldId = oldId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      
      // Attributes that commonly contain references
      const urlRefAttributes = ['fill', 'stroke', 'filter', 'mask', 'clip-path', 
                               'marker-start', 'marker-mid', 'marker-end'];
      const hrefRefAttributes = ['href', 'xlink:href'];
      const smilRefAttributes = ['begin', 'end'];

      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const attrName = attr.name;
        let attrValue = attr.value;
        
        if (!attrValue) continue;
        
        let updated = false;

        // Update url(#id) references
        if (urlRefAttributes.includes(attrName)) {
          const urlRegex = new RegExp(`url\\(['"]?#${escapedOldId}['"]?\\)`, 'g');
          if (urlRegex.test(attrValue)) {
            attrValue = attrValue.replace(urlRegex, `url(#${newId})`);
            updated = true;
          }
        }

        // Update #id references (href/xlink:href)
        if (hrefRefAttributes.includes(attrName) && attrValue === `#${oldId}`) {
          attrValue = `#${newId}`;
          updated = true;
        }

        // Update SMIL timing references
        if (smilRefAttributes.includes(attrName)) {
          const timingRegex = new RegExp(`(^|\\s|;)${escapedOldId}(\\.|;|\\s|$)`, 'g');
          if (timingRegex.test(attrValue)) {
            attrValue = attrValue.replace(timingRegex, `$1${newId}$2`);
            updated = true;
          } else if (attrValue === oldId) {
            attrValue = newId;
            updated = true;
          }
        }

        if (updated) {
          element.setAttribute(attrName, attrValue);
        }
      }
    }

    // Recursively process element IDs
    function processElementIds(element, itemId, idMap) {
      if (!element || element.nodeType !== 1) return;

      const originalId = element.getAttribute('id');

      // Process this element's ID
      if (originalId) {
        const newId = makeIdUnique(originalId, itemId);
        if (newId && newId !== originalId) {
          element.setAttribute('id', newId);
          idMap[originalId] = newId;
          updateIdReferences(element, originalId, newId);
        } else if (newId === originalId) {
          idMap[originalId] = originalId;
          usedIds.add(originalId);
        }
      }

      // Apply known ID mappings to attributes
      for (const [oldId, newId] of Object.entries(idMap)) {
        if (oldId !== originalId) {
          updateIdReferences(element, oldId, newId);
        }
      }

      // Process child elements recursively
      if (element.childNodes) {
        const children = Array.from(element.childNodes);
        for (const child of children) {
          processElementIds(child, itemId, idMap);
        }
      }
    }

    // Process each item in the layout
    for (const item of layout) {
      core.info(`Processing item: ${item.id} (Type: ${item.type}, URL/Path: ${item.url})`);
      
      try {
        let content;
        let isSvg = item.type === 'svg';
        
        // Fetch or read the content
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL
          core.info(`Fetching from URL: ${item.url}`);
          content = await fetchWithRetry(item.url);
        } else if (item.url.startsWith('blob:') || item.url.startsWith('images/')) {
          // Local file
          const imagePath = (item.url.startsWith('blob:') ? item.url.substring(5) : item.url).replace(/\\/g, '/');
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}. Available assets: ${[...assetMap.keys()].join(', ')}`);
          }
          
          const filePath = assetMap.get(imagePath);
          const fileBuffer = await fs.readFile(filePath);
          content = fileBuffer.toString('utf8');
        } else {
          throw new Error(`Unsupported URL/path format: ${item.url}`);
        }

        // Process SVG content
        if (isSvg) {
          // Parse the SVG
          let svgDoc = parser.parseFromString(content, 'text/xml');
          const svgElement = svgDoc.documentElement;
          
          // Check for parser errors
          const parseErrors = svgElement.getElementsByTagName('parsererror');
          if (parseErrors.length > 0) {
            let errorText = 'Unknown parsing error';
            if (parseErrors[0].childNodes.length > 0) {
              const errorSource = parseErrors[0].getElementsByTagName('div')[0] || parseErrors[0];
              errorText = errorSource.textContent || errorText;
            } else {
              errorText = parseErrors[0].textContent || errorText;
            }
            
            if (svgElement.nodeName.toLowerCase() !== 'svg') {
              throw new Error(`Parsed content for item ${item.id} does not have a root <svg> element. Parser message: ${errorText}`);
            }
          }
          
          // Create a group for this item
          const group = rootSvg.createElement('g');
          const groupId = `item_group_${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          group.setAttribute('id', groupId);
          
          // Calculate dimensions for scaling
          let svgIntrinsicWidth, svgIntrinsicHeight;
          
          // Get dimensions from viewBox
          if (svgElement.hasAttribute('viewBox')) {
            const viewBoxParts = svgElement.getAttribute('viewBox').split(/[\s,]+/);
            if (viewBoxParts.length === 4) {
              svgIntrinsicWidth = parseFloat(viewBoxParts[2]);
              svgIntrinsicHeight = parseFloat(viewBoxParts[3]);
              if (svgIntrinsicWidth <= 0) svgIntrinsicWidth = NaN;
              if (svgIntrinsicHeight <= 0) svgIntrinsicHeight = NaN;
            }
          }
          
          // Fallback to width/height attributes
          if (isNaN(svgIntrinsicWidth) && svgElement.hasAttribute('width')) {
            const wAttr = svgElement.getAttribute('width');
            if (!wAttr.includes('%')) svgIntrinsicWidth = parseFloat(wAttr);
          }
          if (isNaN(svgIntrinsicHeight) && svgElement.hasAttribute('height')) {
            const hAttr = svgElement.getAttribute('height');
            if (!hAttr.includes('%')) svgIntrinsicHeight = parseFloat(hAttr);
          }
          
          // Final fallback
          if (isNaN(svgIntrinsicWidth) || svgIntrinsicWidth <= 0) {
            svgIntrinsicWidth = item.width;
          }
          if (isNaN(svgIntrinsicHeight) || svgIntrinsicHeight <= 0) {
            svgIntrinsicHeight = item.height;
          }
          
          // Apply transformation
          let transform = `translate(${item.x}, ${item.y})`;
          
          // Scale if needed
          if (svgIntrinsicWidth > 0 && svgIntrinsicHeight > 0 && 
              item.width > 0 && item.height > 0 && 
              (svgIntrinsicWidth !== item.width || svgIntrinsicHeight !== item.height)) {
            const scaleX = item.width / svgIntrinsicWidth;
            const scaleY = item.height / svgIntrinsicHeight;
            
            if (isFinite(scaleX) && isFinite(scaleY) && scaleX !== 0 && scaleY !== 0) {
              transform += ` scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`;
            }
          }
          
          group.setAttribute('transform', transform);
          
          // Process IDs to make them unique
          const idMap = {};
          processElementIds(svgElement, item.id, idMap);
          
          // Process defs elements
          const svgDefs = Array.from(svgElement.getElementsByTagName('defs'));
          for (const defElement of svgDefs) {
            const childrenToMove = Array.from(defElement.childNodes);
            for (const defChild of childrenToMove) {
              if (defChild.nodeType === 1 && (defChild.hasChildNodes() || defChild.hasAttributes())) {
                const defChildId = defChild.getAttribute('id');
                if (defChildId && defs.querySelector(`[id="${defChildId}"]`)) {
                  core.debug(`Skipping definition with ID ${defChildId} as it already exists`);
                } else {
                  defs.appendChild(defChild);
                }
              }
            }
            
            // Remove the empty defs element
            if (defElement.parentNode) {
              defElement.parentNode.removeChild(defElement);
            }
          }
          
          // Process style elements
          const styleElements = Array.from(svgElement.getElementsByTagName('style'));
          for (const styleElement of styleElements) {
            if (styleElement.textContent) {
              let cssText = styleElement.textContent;
              
              // Update ID references in CSS
              for (const [oldId, newId] of Object.entries(idMap)) {
                if (oldId === newId) continue;
                
                const escapedOldId = oldId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                const idSelectorRegex = new RegExp(`#${escapedOldId}(?![\\w-])`, 'g');
                cssText = cssText.replace(idSelectorRegex, `#${newId}`);
                
                const urlSelectorRegex = new RegExp(`url\\(['"]?#${escapedOldId}['"]?\\)`, 'g');
                cssText = cssText.replace(urlSelectorRegex, `url(#${newId})`);
              }
              
              styleElement.textContent = cssText;
            }
            
            group.appendChild(styleElement);
          }
          
          // Move remaining nodes to the group
          const childNodesToMove = Array.from(svgElement.childNodes);
          for (const node of childNodesToMove) {
            const nodeName = node.nodeName.toLowerCase();
            
            if (node.nodeType === 1 && 
                nodeName !== 'defs' && 
                nodeName !== 'style' && 
                nodeName !== 'title' && 
                nodeName !== 'desc' && 
                nodeName !== 'parsererror') {
              group.appendChild(node);
            }
          }
          
          // Add the group to the root SVG
          rootElement.appendChild(group);
          core.info(`Successfully processed SVG for item ${item.id}`);
        } else if (item.type === 'image') {
          // For non-SVG items, add them as image elements
          // Create a group for the image
          const group = rootSvg.createElement('g');
          const groupId = `item_group_${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          group.setAttribute('id', groupId);
          group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
          
          // Create a foreignObject to embed the content
          const foreignObject = rootSvg.createElement('foreignObject');
          foreignObject.setAttribute('width', item.width.toString());
          foreignObject.setAttribute('height', item.height.toString());
          
          // Create an iframe to show the content
          const iframe = rootSvg.createElement('iframe');
          iframe.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
          iframe.setAttribute('width', '100%');
          iframe.setAttribute('height', '100%');
          iframe.setAttribute('style', 'border: none; overflow: hidden;');
          iframe.setAttribute('src', item.url);
          
          foreignObject.appendChild(iframe);
          group.appendChild(foreignObject);
          rootElement.appendChild(group);
          
          core.info(`Added image reference for item ${item.id}`);
        }
      } catch (error) {
        // Log warning and add a placeholder for the error
        core.warning(`Error processing item ${item.id}: ${error.message}`);
        
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

    // Serialize the SVG to string
    let mergedSvgString = serializer.serializeToString(rootSvg);
    
    // Add XML declaration
    if (!mergedSvgString.startsWith('<?xml')) {
      mergedSvgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + mergedSvgString;
    }

    // Optimize the SVG
    core.info('Optimizing SVG...');
    const svgoOptions = {
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              // Structure preservation
              removeViewBox: false,
              removeUselessDefs: false,
              removeHiddenElems: false,
              removeEmptyContainers: false,
              collapseGroups: false,
              mergePaths: false,
              convertShapeToPath: false,
              
              // ID and style preservation  
              cleanupIDs: false,
              inlineStyles: false,
              minifyStyles: false,
              removeStyleElement: false,
              
              // Other
              removeRasterImages: false,
              removeDimensions: false,
              convertPathData: {
                floatPrecision: 3,
                transformPrecision: 5,
                makeArcs: false,
                straightCurves: false,
                lineCurves: false,
                curveSmoothShorthands: false,
                removeUselessSegments: true,
                collapseRepeated: true,
                utilizeAbsolute: true,
              },
            },
          },
        },
        'removeComments',
        'removeMetadata',
      ],
      multipass: true,
      js2svg: {
        indent: 2,
        pretty: true,
      },
    };

    let finalSvgContent;
    try {
      const optimizedSvg = optimize(mergedSvgString, svgoOptions);
      if (optimizedSvg.error) {
        core.warning(`SVGO optimization failed: ${optimizedSvg.error}`);
        finalSvgContent = mergedSvgString;
      } else {
        finalSvgContent = optimizedSvg.data;
        core.info('SVG optimized successfully.');
      }
    } catch (svgoError) {
      core.warning(`SVGO optimization error: ${svgoError.message}`);
      finalSvgContent = mergedSvgString;
    }

    // Write the final SVG
    const outputFilename = 'README.svg';
    await fs.writeFile(outputFilename, finalSvgContent);
    core.info(`Final SVG written to ${outputFilename}`);

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
  }
}

run();
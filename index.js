import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch'; // Using node-fetch v2 for CommonJS compatibility if needed, or ensure project is ESM
import { optimize } from 'svgo';
// *** Import DOMParser and XMLSerializer from xmldom for SVG manipulation ***
import { DOMParser, XMLSerializer } from 'xmldom';

// *** START: Added Fetch with Retry Logic ***
/**
 * Fetches content from a URL with retry logic.
 * Specifically handles fetching SVG text, including potential JSON wrappers.
 * @param {string} url The URL to fetch.
 * @param {number} maxRetries Maximum number of retry attempts.
 * @param {number} retryDelay Delay between retries in milliseconds.
 * @returns {Promise<string>} The fetched text content (expected to be SVG or JSON containing SVG).
 * @throws {Error} If fetching fails after all retries or content type is unexpected.
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
      core.debug(`Fetched raw content (first 100 chars): ${content.substring(0, 100)}`);
      return content;
    } catch (error) {
      lastError = error; // Store the error from this attempt
    }

    // // If not the last attempt, wait before retrying
    // if (attempt < maxRetries) {
    //   core.warning(`Attempt ${attempt} failed for ${url}: ${lastError.message}. Retrying in ${retryDelay}ms...`);
    //   await new Promise(resolve => setTimeout(resolve, retryDelay));
    // }
  }

  // If loop finishes, all retries failed
  core.error(`Failed to fetch ${url} after ${maxRetries} attempts.`);
  throw lastError; // Throw the last encountered error
}
// *** END: Added Fetch with Retry Logic ***

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

    // *** Initialize XML/DOM parser and serializer ***
    const parser = new DOMParser();
    const serializer = new XMLSerializer();

    // Create a map of asset files for faster lookups
    const assetMap = new Map();
    const assetPatterns = assetsInput.split(',').map(pattern => pattern.trim());

    core.info('Searching for local asset files...');
    for (const pattern of assetPatterns) {
      const globber = await glob.create(pattern);
      const files = await globber.glob();

      for (const file of files) {
        const relativePath = path.relative(process.cwd(), file).replace(/\\/g, '/'); // Normalize path separators
        core.info(`Found asset: ${relativePath} -> ${file}`);
        assetMap.set(relativePath, file);
      }
    }
    core.info(`Found ${assetMap.size} local asset(s).`);

    // Set fixed dimensions for the SVG including background
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;

    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;

    // Create the root SVG DOM with fixed dimensions
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
    backgroundRect.setAttribute('fill', 'white'); // Or use an input for background color
    rootElement.appendChild(backgroundRect);

    // *** Create a single, global <defs> element to store definitions from all merged SVGs ***
    const defs = rootSvg.createElement('defs');
    // Insert defs after the background but before other content
    if (rootElement.firstChild) {
        rootElement.insertBefore(defs, rootElement.firstChild.nextSibling);
    } else {
        rootElement.appendChild(defs);
    }


    // *** Track used IDs globally across all merged SVGs to prevent conflicts ***
    const usedIds = new Set();

    // *** Helper function to make IDs unique by prefixing with item ID ***
    // Ensures generated IDs don't clash across different source SVGs.
    function makeIdUnique(id, itemId) {
      if (!id) return null;

      // Sanitize itemId to be a valid ID prefix (e.g., replace invalid characters)
      const safeItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const newIdBase = `${safeItemId}_${id}`;

      let finalId = newIdBase;
      let counter = 1;
      // Ensure the generated ID is truly unique in the global scope
      while (usedIds.has(finalId)) {
          finalId = `${newIdBase}_${counter++}`;
      }
      usedIds.add(finalId);
      return finalId;
    }

    // *** Helper function to update ID references in attributes (url(#id), href="#id", SMIL timing, CSS) ***
    // This is crucial for ensuring links, gradients, filters, masks, animations etc. still work after IDs are prefixed.
    function updateIdReferences(element, oldId, newId) {
      if (!element || element.nodeType !== 1 || !oldId || !newId || oldId === newId) return; // Only process elements with actual changes

      // Escape special characters in oldId for use in RegExp
      const escapedOldId = oldId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

      // Attributes that commonly contain URL references: url(#id)
      const urlRefAttributes = ['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'];
      // Attributes that commonly contain direct href references: #id
      const hrefRefAttributes = ['href', 'xlink:href']; // Note: xlink:href is deprecated but common
      // Attributes used in SMIL animations that reference IDs
      const smilRefAttributes = ['begin', 'end']; // Can be complex: id.event+time, id.syncbase(value)

      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const attrName = attr.name;
        let attrValue = attr.value;

        if (!attrValue) continue;

        let updated = false;

        // 1. Update url(#id) references
        if (urlRefAttributes.includes(attrName)) {
          const urlRegex = new RegExp(`url\\(['"]?#${escapedOldId}['"]?\\)`, 'g');
          if (urlRegex.test(attrValue)) {
            attrValue = attrValue.replace(urlRegex, `url(#${newId})`);
            updated = true;
          }
        }

        // 2. Update #id references (typically href/xlink:href)
        if (hrefRefAttributes.includes(attrName) && attrValue === `#${oldId}`) {
          attrValue = `#${newId}`;
          updated = true;
        }

        // 3. Update SMIL timing references (e.g., begin="someId.click+1s")
        // This needs to be careful not to replace parts of other IDs.
        // Regex: Replace `oldId` only if it's followed by a '.', ';', space, or end of string,
        // and preceded by start of string, space, or ';'.
        if (smilRefAttributes.includes(attrName)) {
           const timingRegex = new RegExp(`(^|\\s|;)${escapedOldId}(\\.|;|\\s|$)`, 'g');
           if (timingRegex.test(attrValue)) {
               attrValue = attrValue.replace(timingRegex, `$1${newId}$2`);
               updated = true;
           }
           // Also handle cases where the attribute value is *just* the ID
           else if (attrValue === oldId) {
               attrValue = newId;
               updated = true;
           }
        }

        // Update the attribute if it changed
        if (updated) {
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

      // 1. Process this element's ID if it has one
      if (originalId) {
        const newId = makeIdUnique(originalId, itemId); // Generate globally unique ID
        if (newId && newId !== originalId) {
          element.setAttribute('id', newId);
          idMap[originalId] = newId; // Store mapping for reference updates within this SVG fragment

          // Update references *within this element* that might point to its *own old ID*
          // (e.g., animations targeting the element itself via SMIL)
          updateIdReferences(element, originalId, newId);
        } else if (newId === originalId) {
            // If makeIdUnique returns the original ID, it means it was already unique globally
            // We still need to record it in the local idMap for reference updates below
            idMap[originalId] = originalId;
            // Add it to the global set as well, in case it wasn't added by makeIdUnique (edge case)
            usedIds.add(originalId);
        }
      }

      // 2. Process attributes that might reference *other* IDs already mapped within this fragment
      // Apply all known mappings (from parents/siblings processed earlier in this fragment)
      // to the current element's attributes.
      for (const [oldId, newId] of Object.entries(idMap)) {
          if (oldId !== originalId) { // Avoid reprocessing the ID we might have just set
              updateIdReferences(element, oldId, newId);
          }
      }

      // 3. Process child elements recursively
      if (element.childNodes) {
        // Convert NodeList to array to avoid issues with live lists when moving nodes later
        const children = Array.from(element.childNodes);
        for (const child of children) {
          // Pass the current idMap down; it will be augmented by children if they have IDs
          processElementIds(child, itemId, idMap);
        }
      }
    }


    // Process each layout item
    for (const item of layout) {
      core.info(`Processing item: ${item.id} (Type: ${item.type}, URL/Path: ${item.url})`);
      try {
        let content; // Will hold raw SVG string or data URI for non-SVG
        let isSvgType = item.type === 'svg'; // Flag to determine processing path

        // --- Fetch or Read Content ---
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          if (isSvgType) {
            // *** START: Use fetchWithRetry for remote SVGs ***
            core.info(`Fetching remote SVG content from URL: ${item.url}`);
            // Fetch raw SVG text using the retry mechanism
            content = await fetchWithRetry(item.url);
            // Basic validation moved inside fetchWithRetry
            // *** END: Use fetchWithRetry for remote SVGs ***
          } else { // Non-SVG remote content -> Create Data URI
            core.info(`Fetching remote image content from URL: ${item.url}`);
            // Fetch non-SVG normally (retry could be added here too if needed)
            const response = await fetch(item.url);
            if (!response.ok) {
              throw new Error(`Failed to fetch ${item.url}: ${response.status} ${response.statusText}`);
            }
            const contentType = response.headers.get('content-type');
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || `image/${item.type}` || 'image/png'; // Guess mime type if needed
            content = `data:${mimeType};base64,${base64}`; // Create data URI
          }
        } else if (item.url.startsWith('blob:') || item.url.startsWith('images/')) {
          // Handle local files (normalize path)
          const imagePath = (item.url.startsWith('blob:') ? item.url.substring(5) : item.url).replace(/\\/g, '/');
          core.info(`Reading local file: ${imagePath}`);

          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}. Available assets: ${[...assetMap.keys()].join(', ')}`);
          }
          const filePath = assetMap.get(imagePath);
          core.info(`Resolved local path: ${filePath}`);
          const fileBuffer = await fs.readFile(filePath);

          if (isSvgType) {
            // *** Read local SVG as raw text ***
            content = fileBuffer.toString('utf8'); // Raw SVG text
            core.debug(`Read local SVG content (first 100 chars): ${content.substring(0,100)}`);
             // Basic validation
             if (!content.trim().startsWith('<svg') && !content.trim().startsWith('<?xml')) {
              throw new Error(`Content from ${imagePath} does not appear to be valid SVG.`);
            }
          } else { // Non-SVG local file -> Create Data URI
            const base64 = fileBuffer.toString('base64');
            const ext = path.extname(imagePath).toLowerCase().substring(1);
            const mimeType = `image/${ext || item.type || 'png'}`;
            content = `data:${mimeType};base64,${base64}`; // Create data URI
          }
        } else {
          throw new Error(`Unsupported URL/path format: ${item.url}`);
        }

        // --- Process Content ---
        if (isSvgType) {
          // *** START: SVG INLINING LOGIC ***
          core.info(`Inlining SVG for item ${item.id} from ${item.url}`);

          // *** 1. Parse the fetched/read SVG string into a DOM ***
          let svgDoc;
          try {
              // Use 'text/xml' for potentially better error reporting with xmldom,
              // though 'image/svg+xml' is technically more correct.
              svgDoc = parser.parseFromString(content, 'text/xml');
          } catch (parseError) {
              throw new Error(`DOMParser failed for item ${item.id}: ${parseError.message}`);
          }
          const svgElement = svgDoc.documentElement;

          // *** Check for parser errors reported within the DOM ***
          const parseErrors = svgElement.getElementsByTagName('parsererror');
          if (parseErrors.length > 0) {
              // Try to get meaningful error text
              let errorText = 'Unknown parsing error';
              if (parseErrors[0].childNodes.length > 0) {
                  // Often the error message is within a div inside parsererror
                  const errorSource = parseErrors[0].getElementsByTagName('div')[0] || parseErrors[0];
                  errorText = errorSource.textContent || errorText;
              } else {
                  errorText = parseErrors[0].textContent || errorText;
              }

              // Filter out common benign namespace warnings from xmldom if needed
              const isBenignWarning = errorText.includes("attribute ") && errorText.includes(" isn't allowed here") && errorText.includes("xmlns:xlink");
              if (!isBenignWarning || core.isDebug()) { // Show warnings unless benign (or if debugging)
                 core.warning(`Parser warnings/errors for item ${item.id}: ${errorText.substring(0, 500)}...`); // Limit length
              }
              // Decide if it's a fatal error (e.g., if root element is not <svg>)
              if (svgElement.nodeName.toLowerCase() !== 'svg') {
                 throw new Error(`Parsed content for item ${item.id} does not have a root <svg> element. Found <${svgElement.nodeName}> instead. Parser message: ${errorText}`);
              }
          }
          // Additional check if root element is svg (might be missed by parsererror tag)
          if (svgElement.nodeName.toLowerCase() !== 'svg') {
              throw new Error(`Parsed content for item ${item.id} does not have a root <svg> element. Found <${svgElement.nodeName}> instead.`);
          }


          // *** 2. Create a group (<g>) element in the main SVG to hold this item's content ***
          const group = rootSvg.createElement('g');
          // Use a predictable, unique ID for the group itself
          const groupId = `item_group_${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`; // Sanitize item ID for group ID
          group.setAttribute('id', groupId);


          // *** 3. Calculate Scaling and Transformation ***
          let svgIntrinsicWidth, svgIntrinsicHeight;
          // Prefer viewBox for intrinsic dimensions
          if (svgElement.hasAttribute('viewBox')) {
            const viewBoxParts = svgElement.getAttribute('viewBox').split(/[\s,]+/);
            if (viewBoxParts.length === 4) {
                svgIntrinsicWidth = parseFloat(viewBoxParts[2]);
                svgIntrinsicHeight = parseFloat(viewBoxParts[3]);
                // If viewBox width/height are zero or negative, they are invalid
                if (svgIntrinsicWidth <= 0) svgIntrinsicWidth = NaN;
                if (svgIntrinsicHeight <= 0) svgIntrinsicHeight = NaN;
            }
          }
          // Fallback to width/height attributes (handle percentages/units if necessary - simplified here)
          if (isNaN(svgIntrinsicWidth) && svgElement.hasAttribute('width')) {
            const wAttr = svgElement.getAttribute('width');
            if (!wAttr.includes('%')) svgIntrinsicWidth = parseFloat(wAttr);
          }
          if (isNaN(svgIntrinsicHeight) && svgElement.hasAttribute('height')) {
            const hAttr = svgElement.getAttribute('height');
            if (!hAttr.includes('%')) svgIntrinsicHeight = parseFloat(hAttr);
          }
          // Final fallback: use target dimensions (scale = 1)
          if (isNaN(svgIntrinsicWidth) || svgIntrinsicWidth <= 0) {
              core.warning(`Could not determine valid intrinsic width for SVG ${item.id}. Assuming target width ${item.width}.`);
              svgIntrinsicWidth = item.width;
          }
          if (isNaN(svgIntrinsicHeight) || svgIntrinsicHeight <= 0) {
              core.warning(`Could not determine valid intrinsic height for SVG ${item.id}. Assuming target height ${item.height}.`);
              svgIntrinsicHeight = item.height;
          }

          // Apply transformations (translate and scale) to the group
          let transform = `translate(${item.x}, ${item.y})`;
          // Only scale if intrinsic and target dimensions are valid and different
          if (svgIntrinsicWidth > 0 && svgIntrinsicHeight > 0 && item.width > 0 && item.height > 0 && (svgIntrinsicWidth !== item.width || svgIntrinsicHeight !== item.height)) {
            const scaleX = item.width / svgIntrinsicWidth;
            const scaleY = item.height / svgIntrinsicHeight;
            // Prevent scaling by zero or infinity
            if (isFinite(scaleX) && isFinite(scaleY) && scaleX !== 0 && scaleY !== 0) {
                 // Use toFixed for cleaner output, adjust precision as needed
                 transform += ` scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`;
            } else {
                core.warning(`Invalid scaling factor calculated for ${item.id} (scaleX: ${scaleX}, scaleY: ${scaleY}). Skipping scale transform.`);
            }
          }
          group.setAttribute('transform', transform);


          // *** 4. Process IDs, Defs, Styles, and Content within the fetched SVG ***
          const idMap = {}; // Map to track old ID -> new ID for *this* item

          // *** 4a. Process IDs recursively throughout the *entire* parsed SVG structure first ***
          // This ensures all IDs are unique and the idMap is complete before moving elements.
          core.debug(`Processing IDs for item ${item.id}...`);
          processElementIds(svgElement, item.id, idMap);
          core.debug(`ID Map for ${item.id}: ${JSON.stringify(idMap)}`);

          // *** 4b. Process Defs: Move children of <defs> to the root <defs> ***
          // The IDs within these defs should already be unique from step 4a.
          const svgDefs = Array.from(svgElement.getElementsByTagName('defs')); // Convert to array before iterating/modifying
          core.debug(`Found ${svgDefs.length} <defs> elements in ${item.id}`);
          for (const defElement of svgDefs) {
            const childrenToMove = Array.from(defElement.childNodes); // Convert to array
            for (const defChild of childrenToMove) {
              // Move only element nodes (type 1) that have content or are recognized defs elements
              // Also check if the ID already exists in the global defs to avoid duplicates (optional, relies on good ID handling)
              if (defChild.nodeType === 1 && (defChild.hasChildNodes() || defChild.hasAttributes())) {
                 const defChildId = defChild.getAttribute('id');
                 // Optional check: Avoid adding if an element with the same (new) ID is already in global defs
                 if (defChildId && defs.querySelector(`[id="${defChildId}"]`)) {
                     core.debug(`Skipping definition element <${defChild.nodeName}> (ID: ${defChildId}) as an element with this ID already exists in root defs.`);
                 } else {
                     core.debug(`Moving definition element <${defChild.nodeName}> (ID: ${defChildId}) to root defs.`);
                     // Append the *original* node (already ID-processed) to the root defs
                     defs.appendChild(defChild); // Appending moves the node
                 }
              } else if (defChild.nodeType !== 3 || defChild.textContent.trim()) {
                 // Keep significant text/comment nodes within defs if desired (less common)
                 // defs.appendChild(defChild.cloneNode(true));
              }
            }
            // Remove the now-empty <defs> element from its original place if it's still there
            if (defElement.parentNode) {
                defElement.parentNode.removeChild(defElement);
            }
          }

          // *** 4c. Process Styles: Move <style> elements into the item's group, update selectors ***
          const styleElements = Array.from(svgElement.getElementsByTagName('style')); // Convert to array
          core.debug(`Found ${styleElements.length} <style> elements in ${item.id}`);
          for (const styleElement of styleElements) {
              if (styleElement.textContent) {
                  let cssText = styleElement.textContent;
                  // Update ID selectors (#oldId) within the CSS using the idMap
                  for (const [oldId, newId] of Object.entries(idMap)) {
                      if (oldId === newId) continue; // No change needed
                      // Use regex to safely replace #oldId selectors
                      // Positive Lookbehind `(?<=#)` ensures we only match IDs starting with #
                      // Negative Lookahead `(?![\\w-])` ensures we don't match partial IDs (e.g., #oldId-variant)
                      // Global flag `g` to replace all occurrences
                      const escapedOldId = oldId.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                      // Regex: Match # followed by the exact old ID, not followed by word/hyphen chars
                      const idSelectorRegex = new RegExp(`#${escapedOldId}(?![\\w-])`, 'g');
                      const oldCssText = cssText;
                      cssText = cssText.replace(idSelectorRegex, `#${newId}`);
                      if (cssText !== oldCssText && core.isDebug()) {
                          core.debug(`CSS ID Selector updated in style for ${item.id}: #${oldId} -> #${newId}`);
                      }

                      // Update url(#id) references within styles (e.g., for filters, masks)
                      const urlSelectorRegex = new RegExp(`url\\(['"]?#${escapedOldId}['"]?\\)`, 'g');
                      const oldCssTextForUrl = cssText;
                      cssText = cssText.replace(urlSelectorRegex, `url(#${newId})`);
                       if (cssText !== oldCssTextForUrl && core.isDebug()) {
                          core.debug(`CSS url(#ID) updated in style for ${item.id}: url(#${oldId}) -> url(#${newId})`);
                      }
                  }
                  styleElement.textContent = cssText; // Update the style element's content
              }
              // Move the processed style element into the item's group <g>
              core.debug(`Moving <style> element into group for ${item.id}`);
              group.appendChild(styleElement); // Appending moves the node
          }


          // *** 4d. Process remaining child nodes: Move them into the item's group ***
          // These nodes should already have updated IDs and references from step 4a.
          const childNodesToMove = Array.from(svgElement.childNodes); // Convert to array
          core.debug(`Moving ${childNodesToMove.length} main child nodes for ${item.id}`);
          for (const node of childNodesToMove) {
            const nodeName = node.nodeName.toLowerCase();

            // Skip defs and style elements as they were handled/moved above
            // Also skip title and desc of the source SVG root if present (optional)
            // Also skip parsererror elements
            if (node.nodeType === 1 && nodeName !== 'defs' && nodeName !== 'style' && nodeName !== 'title' && nodeName !== 'desc' && nodeName !== 'parsererror') {
              // Move the element node into the group
              group.appendChild(node); // Appending moves the node
            } else if (node.nodeType === 3 && node.textContent.trim()) {
                // Keep significant text nodes if any (less common directly under <svg>)
                // group.appendChild(node.cloneNode(true)); // Clone text nodes
            } else if (node.nodeType === 8) {
                // Keep comments if desired
                // group.appendChild(node.cloneNode(true)); // Clone comments
            }
          }

          // *** 5. Add the fully processed group (with transformed, ID-updated content) to the root SVG ***
          rootElement.appendChild(group);
          core.info(`Successfully inlined and processed SVG for item ${item.id}`);
          // *** END: SVG INLINING LOGIC ***

        } else {
          // *** Non-SVG Image Embedding (using <image> and data URI) ***
          // This logic remains the same for non-SVG types like PNG, JPG
          core.info(`Embedding image for item ${item.id} using <image> tag`);
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', `item_image_${item.id}`); // Use item ID with prefix
          imageElement.setAttribute('x', String(item.x));
          imageElement.setAttribute('y', String(item.y));
          imageElement.setAttribute('width', String(item.width));
          imageElement.setAttribute('height', String(item.height));
          // The 'content' here is already a data URI prepared earlier
          imageElement.setAttribute('href', content); // Use 'href' (SVG 2 standard)
          // imageElement.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', content); // Add xlink:href for broader compatibility if needed
          // Preserve aspect ratio behavior (optional, default is 'defer')
          // imageElement.setAttribute('preserveAspectRatio', 'xMidYMid meet');

          rootElement.appendChild(imageElement);
        }
      } catch (error) {
        // Log warning instead of failing the whole action for one item
        core.warning(`Error processing item ${item.id} (URL/Path: ${item.url}): ${error.message}\n${error.stack || ''}`);
        // Optionally add a visual placeholder in the SVG to indicate the error
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

    // Serialize the final merged SVG DOM back to a string
    let mergedSvgString = serializer.serializeToString(rootSvg);

    // Add XML declaration if missing (good practice)
    if (!mergedSvgString.startsWith('<?xml')) {
        mergedSvgString = '<?xml version="1.0" encoding="UTF-8"?>\n' + mergedSvgString;
    }

    // Write merged SVG to temporary file (optional, for debugging)
    // await fs.writeFile('merged_unoptimized.svg', mergedSvgString);
    // core.info('Saved unoptimized merged SVG to merged_unoptimized.svg');

    // Optimize SVG with SVGO - **Crucially, preserve IDs and styles/structure for animations**
    core.info('Optimizing SVG with SVGO...');
    const svgoOptions = {
        plugins: [
            {
                name: 'preset-default',
                params: {
                    overrides: {
                        // --- Structure Preservation ---
                        removeViewBox: false, // Keep root viewBox
                        removeUselessDefs: false, // Defs might be used by animations/scripts we don't see
                        removeUnknownsAndDefaults: { // Be very conservative
                            unknownContent: false,
                            unknownAttrs: false,
                            keepDataAttrs: true,
                            keepAriaAttrs: true,
                            keepRoleAttr: true,
                        },
                        removeHiddenElems: false, // Might be revealed by animation
                        removeEmptyContainers: false, // Might be used by scripts or for layout
                        moveElemsAttrsToGroup: false, // Avoid restructuring
                        moveGroupAttrsToElems: false, // Avoid restructuring
                        collapseGroups: false, // VERY IMPORTANT: Keep groups for transforms & structure
                        mergePaths: false, // Can break structure/animations
                        convertShapeToPath: false, // Keep original shapes if possible
                        removeNonInheritableGroupAttrs: false, // Keep attributes on groups

                        // --- ID and Style Preservation ---
                        cleanupIDs: false, // VERY IMPORTANT: We handled ID uniqueness manually
                        inlineStyles: false, // Keep <style> blocks for animations/complex CSS
                        minifyStyles: false, // Avoid breaking complex selectors/keyframes
                        removeStyleElement: false, // Keep <style> elements
                        removeScriptElement: false, // Keep <script> elements (though GitHub might strip them anyway)

                        // --- Other ---
                        removeRasterImages: false, // Keep embedded <image> tags
                        removeDimensions: false, // Keep root width/height
                        removeTitle: false, // Keep titles if present
                        removeDesc: false, // Keep descriptions if present
                        convertPathData: { // Conservative path optimization
                            floatPrecision: 3, // Standard precision
                            transformPrecision: 5, // Higher precision for transforms
                            makeArcs: false, // Avoid changing arc representation
                            straightCurves: false, // Avoid converting curves to lines
                            lineCurves: false, // Avoid converting lines to curves
                            curveSmoothShorthands: false, // Avoid shorthand that might break some renderers
                            removeUselessSegments: true,
                            collapseRepeated: true,
                            utilizeAbsolute: true, // Prefer absolute, often shorter
                        },
                        // sortAttrs: false, // Keep attribute order (can matter for some parsers/renderers)
                    },
                },
            },
            // Explicitly enable/disable plugins not in preset-default if needed
            'removeComments', // Safe to remove
            'removeMetadata', // Safe to remove
            // 'removeXMLProcInst', // Keep XML declaration added earlier
        ],
        multipass: true, // Run multiple passes for better optimization
        js2svg: {
            indent: 2, // Pretty output for readability
            pretty: true,
        },
    };

    let finalSvgContent;
    try {
        const optimizedSvg = optimize(mergedSvgString, svgoOptions);
        if (optimizedSvg.error) {
            core.warning(`SVGO optimization failed: ${optimizedSvg.error}`);
            core.warning('Using unoptimized SVG due to SVGO error.');
            finalSvgContent = mergedSvgString; // Fallback to unoptimized
        } else {
            finalSvgContent = optimizedSvg.data;
            core.info('SVG optimized successfully.');
        }
    } catch (svgoError) {
         core.warning(`SVGO optimization threw an exception: ${svgoError.message}`);
         core.warning('Using unoptimized SVG due to SVGO exception.');
         finalSvgContent = mergedSvgString; // Fallback to unoptimized
    }


    // Write the final SVG (optimized or unoptimized)
    const outputFilename = 'README.svg'; // Or make this configurable
    await fs.writeFile(outputFilename, finalSvgContent);
    core.info(`Final SVG written to ${outputFilename}`);


    // --- Git Commit and Push ---
    core.info('Configuring Git...');
    await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
    await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);

    core.info(`Checking for changes in ${outputFilename}...`);
    // Use 'git status --porcelain' for a reliable check
    let gitStatusOutput = '';
    const statusOptions = {
        listeners: {
            stdout: (data) => { gitStatusOutput += data.toString(); }
        },
        ignoreReturnCode: true // Don't fail if status returns non-zero
    };
    await exec.exec('git', ['status', '--porcelain', outputFilename], statusOptions);

    // Check if the output file is modified, untracked, or added
    if (gitStatusOutput.includes(outputFilename)) {
        core.info(`Changes detected in ${outputFilename}. Staging file...`);
        await exec.exec('git', ['add', outputFilename]);

        // Check diff --staged to see if there are actual content changes staged
        // This prevents empty commits if the file was added but is identical to HEAD
        const diffExitCode = await exec.exec('git', ['diff', '--staged', '--quiet'], { ignoreReturnCode: true });

        if (diffExitCode !== 0) {
            core.info('Staged changes detected. Committing...');
            await exec.exec('git', ['commit', '-m', 'ci: update profile svg']); // Customize commit message if needed

            const repository = `https://x-access-token:${token}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
            // *** Determine the correct branch to push to ***
            // GITHUB_HEAD_REF is set for PRs (branch name of the PR)
            // GITHUB_REF_NAME is set for pushes (branch or tag name)
            const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
            if (!branch) {
                core.setFailed('Could not determine branch name from GITHUB_HEAD_REF or GITHUB_REF_NAME');
                return;
            }
            core.info(`Pushing changes to branch: ${branch}`);
            // Use --force-with-lease or handle potential conflicts if necessary, but simple push is often fine for bot commits
            await exec.exec('git', ['push', repository, `HEAD:${branch}`]);

            core.info(`Successfully committed and pushed updated ${outputFilename}`);
        } else {
             core.info(`${outputFilename} staged, but no effective changes detected compared to HEAD. Skipping commit.`);
             // Optional: Reset the staging area if no commit is made to avoid confusion
             await exec.exec('git', ['reset', 'HEAD', outputFilename]);
        }
    } else {
      core.info(`No changes detected in ${outputFilename}. Nothing to commit.`);
    }

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}\n${error.stack}`);
  }
}

run();

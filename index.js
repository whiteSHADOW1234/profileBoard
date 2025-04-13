import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from 'xmldom';

/**
 * Fetches SVG content from a URL and returns the raw SVG text
 * @param {string} url - The URL to fetch the SVG from
 * @returns {Promise<string|null>} - The SVG content or null if failed
 */
async function fetchSVGContent(url) {
  try {
    core.info(`Fetching SVG from URL: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    
    const contentType = response.headers.get('content-type');
    
    // Check if the response is SVG
    if (contentType && !contentType.includes('svg') && !contentType.includes('text/plain') && !contentType.includes('text/html')) {
      core.warning(`URL ${url} returned non-SVG content type: ${contentType}. Will try to parse anyway.`);
    }
    
    return await response.text();
  } catch (error) {
    core.warning(`Failed to fetch SVG from ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Loads an SVG file from disk
 * @param {string} filePath - Path to the SVG file
 * @returns {Promise<string|null>} - The SVG content or null if failed
 */
async function loadSVGFile(filePath, assetMap) {
  try {
    if (!assetMap.has(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    const content = await fs.readFile(assetMap.get(filePath), 'utf8');
    return content;
  } catch (error) {
    core.warning(`Failed to load SVG file ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Extracts viewBox, width, and height from an SVG element
 * @param {Element} svgElement - The SVG DOM element
 * @param {object} item - The layout item with width and height
 * @returns {object} - The dimensions
 */
function extractSVGDimensions(svgElement, item) {
  let width, height, viewBox;
  
  if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
    width = parseFloat(svgElement.getAttribute('width'));
    height = parseFloat(svgElement.getAttribute('height'));
  }
  
  if (svgElement.hasAttribute('viewBox')) {
    viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/).map(parseFloat);
    // If width/height weren't explicitly set, use viewBox dimensions
    if (!width && viewBox.length >= 3) width = viewBox[2];
    if (!height && viewBox.length >= 4) height = viewBox[3];
  }
  
  // Fallback to the specified item dimensions
  width = width || item.width;
  height = height || item.height;
  
  return { width, height, viewBox };
}

/**
 * Processes an image item (creating image element)
 * @param {object} item - The layout item
 * @param {string} imageData - The image data (base64 or URL)
 * @param {Document} rootSvg - The root SVG document
 * @returns {Element} - The created image element
 */
function processImageItem(item, imageData, rootSvg) {
  const imageElement = rootSvg.createElement('image');
  imageElement.setAttribute('x', item.x);
  imageElement.setAttribute('y', item.y);
  imageElement.setAttribute('width', item.width);
  imageElement.setAttribute('height', item.height);
  imageElement.setAttribute('href', imageData);
  return imageElement;
}

/**
 * Main function to run the action
 */
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
    
    // Set fixed dimensions as requested
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
    
    // Create a global defs element for storing all definitions
    const globalDefs = rootSvg.createElement('defs');
    rootElement.appendChild(globalDefs);
    
    // Process each layout item
    for (const item of layout) {
      try {
        // Process based on item type
        if (item.type === 'svg') {
          let svgContent;
          
          // Handle different URL types for SVG
          if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
            // Fetch SVG content from URL
            svgContent = await fetchSVGContent(item.url);
            if (!svgContent) {
              throw new Error(`Failed to fetch SVG content from ${item.url}`);
            }
          } else if (item.url.startsWith('blob:')) {
            // Load SVG from local file (blob: prefix)
            const filePath = item.url.substring(5); // Remove 'blob:' prefix
            const imagePath = path.join('images', filePath);
            svgContent = await loadSVGFile(imagePath, assetMap);
            if (!svgContent) {
              throw new Error(`Failed to load SVG file from ${imagePath}`);
            }
          } else if (item.url.startsWith('images/')) {
            // Direct path to images directory
            svgContent = await loadSVGFile(item.url, assetMap);
            if (!svgContent) {
              throw new Error(`Failed to load SVG file from ${item.url}`);
            }
          } else {
            throw new Error(`Unsupported URL format for SVG: ${item.url}`);
          }
          
          // Parse the SVG content
          let svgDoc;
          try {
            svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
          } catch (parseError) {
            throw new Error(`Failed to parse SVG content from ${item.url}: ${parseError.message}`);
          }
          
          const svgElement = svgDoc.documentElement;
          if (!svgElement || svgElement.nodeName !== 'svg') {
            throw new Error(`Invalid SVG content from ${item.url}`);
          }
          
          // Extract dimensions
          const { width: svgWidth, height: svgHeight } = extractSVGDimensions(svgElement, item);
          
          // Create a group to position and scale the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('id', `item-${item.id || Math.random().toString(36).substring(2, 10)}`);
          
          // Calculate transformation and apply it
          const scaleX = item.width / svgWidth;
          const scaleY = item.height / svgHeight;
          group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
          
          // Extract and process definitions (defs) for reuse
          const defsElements = svgElement.getElementsByTagName('defs');
          for (let i = 0; i < defsElements.length; i++) {
            const defs = defsElements[i];
            // Add a prefix to all IDs in defs to avoid conflicts
            const prefix = `svg-${item.id || i}-`;
            const children = defs.childNodes;
            
            for (let j = 0; j < children.length; j++) {
              const child = children[j];
              if (child.nodeType === 1) { // Element node
                if (child.hasAttribute('id')) {
                  // Generate a unique ID based on the original
                  const originalId = child.getAttribute('id');
                  const newId = `${prefix}${originalId}`;
                  child.setAttribute('id', newId);
                  
                  // Clone the node and add to global defs
                  globalDefs.appendChild(child.cloneNode(true));
                  
                  // Update references to this ID in the SVG
                  // This is a simplified approach; a full implementation would need to update all references
                  // in attributes like 'href', 'url(#id)', etc.
                }
              }
            }
          }
          
          // Copy all non-defs elements with their attributes and content
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'defs') {
              // Clone child elements into our group
              group.appendChild(node.cloneNode(true));
            }
          }
          
          // Copy necessary attributes from source SVG
          const attributesToCopy = ['style', 'class'];
          for (const attr of attributesToCopy) {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          }
          
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          let imageData;
          
          // Handle different URL types for images
          if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
            // Fetch image from URL and convert to base64
            const response = await fetch(item.url);
            if (!response.ok) {
              throw new Error(`Failed to fetch image from ${item.url}: ${response.statusText}`);
            }
            
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = response.headers.get('content-type') || 'image/png';
            imageData = `data:${mimeType};base64,${base64}`;
          } else if (item.url.startsWith('blob:')) {
            // Load image from local file (blob: prefix)
            const filePath = item.url.substring(5); // Remove 'blob:' prefix
            const imagePath = path.join('images', filePath);
            
            if (!assetMap.has(imagePath)) {
              throw new Error(`Image file not found: ${imagePath}`);
            }
            
            const fileContent = await fs.readFile(assetMap.get(imagePath));
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            imageData = `data:${mimeType};base64,${base64}`;
          } else if (item.url.startsWith('images/')) {
            // Direct path to images directory
            if (!assetMap.has(item.url)) {
              throw new Error(`Image file not found: ${item.url}`);
            }
            
            const fileContent = await fs.readFile(assetMap.get(item.url));
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            imageData = `data:${mimeType};base64,${base64}`;
          } else {
            throw new Error(`Unsupported URL format for image: ${item.url}`);
          }
          
          // Create and add the image element
          const imageElement = processImageItem(item, imageData, rootSvg);
          rootElement.appendChild(imageElement);
        }
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
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
              // Disable plugins that might break animations
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
              inlineStyles: false,
              minifyStyles: false,
              cleanupIDs: false,
              removeDoctype: false,
              removeXMLProcInst: false
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
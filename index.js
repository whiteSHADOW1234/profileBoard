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
 * Fetches SVG content from a URL and returns the raw SVG string
 * @param {string} url - The URL to fetch SVG from
 * @returns {Promise<string|null>} - The SVG content or null if failed
 */
async function fetchSVGContent(url) {
  try {
    core.info(`Fetching SVG from URL: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('svg') && !contentType.includes('xml') && !contentType.includes('text')) {
      core.warning(`URL ${url} did not return SVG content (got ${contentType}), but will try to parse anyway`);
    }
    
    return await response.text();
  } catch (error) {
    core.error(`Failed to fetch SVG from ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Fetches image content from a URL and returns base64 data URI
 * @param {string} url - The URL to fetch image from
 * @returns {Promise<string|null>} - The image as data URI or null if failed
 */
async function fetchImageContent(url) {
  try {
    core.info(`Fetching image from URL: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/png';
    
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    core.error(`Failed to fetch image from ${url}: ${error.message}`);
    return null;
  }
}

/**
 * Reads a local file and returns its content
 * @param {string} filePath - Path to the file
 * @param {boolean} isBinary - Whether to read as binary
 * @param {Map} assetMap - Map of asset files
 * @returns {Promise<string|null>} - The file content or null if failed
 */
async function readLocalFile(filePath, isBinary, assetMap) {
  try {
    core.info(`Reading local file: ${filePath}`);
    
    if (!assetMap.has(filePath)) {
      throw new Error(`Local asset not found: ${filePath}`);
    }
    
    const fileContent = await fs.readFile(assetMap.get(filePath));
    
    if (isBinary) {
      const base64 = fileContent.toString('base64');
      const extension = path.extname(filePath).substring(1).toLowerCase();
      const mimeType = extension === 'svg' ? 'image/svg+xml' : `image/${extension || 'png'}`;
      return `data:${mimeType};base64,${base64}`;
    } else {
      return fileContent.toString('utf8');
    }
  } catch (error) {
    core.error(`Failed to read local file ${filePath}: ${error.message}`);
    return null;
  }
}

/**
 * Extracts the SVG content from an SVG string
 * @param {string} svgString - The SVG string
 * @param {DOMParser} parser - XML DOM parser
 * @returns {Element} - The SVG element
 */
function extractSVGElement(svgString, parser) {
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  return doc.documentElement;
}

/**
 * Creates a group element containing the SVG content positioned at the specified coordinates
 * @param {Element} svgElement - The source SVG element
 * @param {Object} item - The layout item with coordinates
 * @param {Document} rootSvg - The root SVG document
 * @returns {Element} - The group element with positioned SVG content
 */
function createSVGGroup(svgElement, item, rootSvg) {
  const group = rootSvg.createElement('g');
  
  // Get SVG dimensions
  let svgWidth, svgHeight;
  
  if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
    svgWidth = parseFloat(svgElement.getAttribute('width'));
    svgHeight = parseFloat(svgElement.getAttribute('height'));
  } else if (svgElement.hasAttribute('viewBox')) {
    const viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/);
    svgWidth = parseFloat(viewBox[2]);
    svgHeight = parseFloat(viewBox[3]);
  } else {
    // Default dimensions if not specified
    svgWidth = item.width;
    svgHeight = item.height;
  }
  
  // Apply translation and scaling
  if (svgWidth !== item.width || svgHeight !== item.height) {
    const scaleX = item.width / svgWidth;
    const scaleY = item.height / svgHeight;
    group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
  } else {
    group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
  }
  
  // Preserve important attributes from source SVG
  ['style', 'class', 'xmlns:xlink'].forEach(attr => {
    if (svgElement.hasAttribute(attr)) {
      group.setAttribute(attr, svgElement.getAttribute(attr));
    }
  });
  
  // Extract all definitions (defs) and add them to the group
  // This preserves animations, gradients, patterns, etc.
  const defsElements = svgElement.getElementsByTagName('defs');
  for (let i = 0; i < defsElements.length; i++) {
    group.appendChild(defsElements[i].cloneNode(true));
  }
  
  // Copy all non-defs child nodes to maintain structure and animations
  for (let i = 0; i < svgElement.childNodes.length; i++) {
    const node = svgElement.childNodes[i];
    if (node.nodeName !== 'defs') {
      group.appendChild(node.cloneNode(true));
    }
  }
  
  return group;
}

/**
 * Main function for the GitHub Action
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
    
    // Process each layout item
    for (const item of layout) {
      try {
        let content;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          if (item.type === 'svg') {
            // For SVGs, fetch the actual SVG source code
            content = await fetchSVGContent(item.url);
          } else {
            // For images, fetch as data URI
            content = await fetchImageContent(item.url);
          }
          
          if (!content) {
            throw new Error(`Failed to fetch content from ${item.url}`);
          }
        } else if (item.url.startsWith('blob:')) {
          // Local file with blob: prefix
          const filePath = item.url.substring(5); // Remove 'blob:' prefix
          const imagePath = path.join('images', filePath);
          
          content = await readLocalFile(imagePath, item.type !== 'svg', assetMap);
          
          if (!content) {
            throw new Error(`Failed to read local file: ${imagePath}`);
          }
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;
          
          content = await readLocalFile(imagePath, item.type !== 'svg', assetMap);
          
          if (!content) {
            throw new Error(`Failed to read local file: ${imagePath}`);
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process content based on type
        if (item.type === 'svg') {
          // Parse SVG content
          const svgElement = extractSVGElement(content, parser);
          
          // Create a group with the SVG content
          const group = createSVGGroup(svgElement, item, rootSvg);
          
          // Append the group to the root SVG
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('x', item.x);
          imageElement.setAttribute('y', item.y);
          imageElement.setAttribute('width', item.width);
          imageElement.setAttribute('height', item.height);
          imageElement.setAttribute('href', content);
          
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
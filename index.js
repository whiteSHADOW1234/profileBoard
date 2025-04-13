import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
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
    
    // Define background dimensions
    const bgMinX = -150;
    const bgMaxX = 1050;
    const bgMinY = 0;
    const bgMaxY = 600;
    
    // Calculate canvas dimensions based on layout items
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    
    // Process each layout item to find dimensions
    layout.forEach(item => {
      const itemLeft = item.x;
      const itemTop = item.y;
      const itemRight = item.x + item.width;
      const itemBottom = item.y + item.height;
      
      if (itemLeft < minX) minX = itemLeft;
      if (itemTop < minY) minY = itemTop;
      if (itemRight > maxX) maxX = itemRight;
      if (itemBottom > maxY) maxY = itemBottom;
    });
    
    // Also consider background area
    minX = Math.min(minX, bgMinX);
    minY = Math.min(minY, bgMinY);
    maxX = Math.max(maxX, bgMaxX);
    maxY = Math.max(maxY, bgMaxY);
    
    const canvasWidth = maxX - minX;
    const canvasHeight = maxY - minY;
    
    // Create root SVG document
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${canvasWidth}" height="${canvasHeight}" viewBox="${minX} ${minY} ${canvasWidth} ${canvasHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Add background area indicator rectangle (optional)
    // Uncomment if you want to see the background area visually
    /*
    const bgRect = rootSvg.createElement('rect');
    bgRect.setAttribute('x', String(bgMinX));
    bgRect.setAttribute('y', String(bgMinY));
    bgRect.setAttribute('width', String(bgMaxX - bgMinX));
    bgRect.setAttribute('height', String(bgMaxY - bgMinY));
    bgRect.setAttribute('fill', 'none');
    bgRect.setAttribute('stroke', '#ff000033');
    bgRect.setAttribute('stroke-width', '1');
    bgRect.setAttribute('stroke-dasharray', '5,5');
    rootElement.appendChild(bgRect);
    */
    
    // Add a central defs element to store all definitions
    const defsElement = rootSvg.createElement('defs');
    rootElement.appendChild(defsElement);
    
    // Helper function to fetch SVG content from URL
    async function fetchSVGContent(url) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
        }
        return await response.text();
      } catch (error) {
        core.error(`Failed to fetch ${url}: ${error.message}`);
        return null;
      }
    }
    
    // Helper function to generate unique IDs
    function generateUniqueId(prefix = 'id-') {
      return `${prefix}${Math.random().toString(36).substring(2, 11)}`;
    }
    
    // Process each layout item
    for (const item of layout) {
      try {
        let content;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          
          if (item.type === 'svg') {
            // Fetch real SVG source code
            content = await fetchSVGContent(item.url);
            
            if (!content) {
              throw new Error(`Failed to fetch SVG content from ${item.url}`);
            }
          } else {
            // For images, fetch and convert to base64
            const response = await fetch(item.url);
            
            if (!response.ok) {
              throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
            }
            
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = response.headers.get('content-type') || 'image/png';
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
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
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
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            content = `data:${mimeType};base64,${base64}`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process content based on type
        if (item.type === 'svg') {
          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          // Create a unique group ID for this SVG
          const groupId = generateUniqueId('svg-group-');
          
          // Create a group to position and scale the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('id', groupId);
          group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
          
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
          
          // Apply scale if necessary
          if (svgWidth !== item.width || svgHeight !== item.height) {
            const scaleX = item.width / svgWidth;
            const scaleY = item.height / svgHeight;
            group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
          }
          
          // Process all defs and add them to the main defs element
          const svgDefs = svgElement.getElementsByTagName('defs');
          const idMap = new Map(); // Map original IDs to new unique IDs
          
          // Function to create a new unique ID and store the mapping
          function mapId(originalId) {
            if (!originalId) return null;
            if (!idMap.has(originalId)) {
              idMap.set(originalId, generateUniqueId(`${groupId}-`));
            }
            return idMap.get(originalId);
          }
          
          // Process all defs elements
          for (let i = 0; i < svgDefs.length; i++) {
            const defsNode = svgDefs[i];
            
            // Process all children of defs
            for (let j = 0; j < defsNode.childNodes.length; j++) {
              const defChild = defsNode.childNodes[j];
              
              // Only process element nodes
              if (defChild.nodeType === 1) { // ELEMENT_NODE
                // Clone the definition
                const clonedDef = defChild.cloneNode(true);
                
                // If the def has an ID, create a new unique ID
                if (clonedDef.hasAttribute('id')) {
                  const originalId = clonedDef.getAttribute('id');
                  const newId = mapId(originalId);
                  clonedDef.setAttribute('id', newId);
                }
                
                // Add to main defs
                defsElement.appendChild(clonedDef);
              }
            }
          }
          
          // Function to update all ID references in attributes
          function updateIdReferences(node) {
            if (node.nodeType !== 1) return; // Only process element nodes
            
            // List of attributes that might contain ID references
            const idRefAttributes = [
              'href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start',
              'marker-mid', 'marker-end', 'begin', 'end'
            ];
            
            // Check and update each attribute
            for (const attr of idRefAttributes) {
              if (node.hasAttribute(attr)) {
                let value = node.getAttribute(attr);
                
                // Check for URL references like "url(#id)"
                const urlMatch = value.match(/url\(#([^)]+)\)/);
                if (urlMatch) {
                  const originalId = urlMatch[1];
                  const newId = mapId(originalId);
                  if (newId) {
                    value = value.replace(`url(#${originalId})`, `url(#${newId})`);
                    node.setAttribute(attr, value);
                  }
                }
                // Check for direct ID references like "#id"
                else if (value.startsWith('#')) {
                  const originalId = value.substring(1);
                  const newId = mapId(originalId);
                  if (newId) {
                    node.setAttribute(attr, `#${newId}`);
                  }
                }
              }
            }
            
            // Process animation elements for things like begin="otherElement.end"
            if (['animate', 'animateTransform', 'animateMotion', 'set'].includes(node.nodeName.toLowerCase())) {
              for (const attr of ['begin', 'end']) {
                if (node.hasAttribute(attr)) {
                  const value = node.getAttribute(attr);
                  // Check for element ID references like "id.begin" or "id.end"
                  const timeRefMatch = value.match(/([^.\s]+)\.(begin|end|click|activate)/);
                  if (timeRefMatch) {
                    const originalId = timeRefMatch[1];
                    const newId = mapId(originalId);
                    if (newId) {
                      const newValue = value.replace(originalId, newId);
                      node.setAttribute(attr, newValue);
                    }
                  }
                }
              }
            }
            
            // Process children recursively
            for (let i = 0; i < node.childNodes.length; i++) {
              updateIdReferences(node.childNodes[i]);
            }
          }
          
          // Copy all child nodes to maintain structure and animations
          function copyChildNodes(source, target) {
            for (let i = 0; i < source.childNodes.length; i++) {
              const node = source.childNodes[i];
              
              // Skip defs nodes as they're handled separately
              if (node.nodeName !== 'defs') {
                // Handle IDs in this node
                if (node.nodeType === 1) { // ELEMENT_NODE
                  if (node.hasAttribute('id')) {
                    const originalId = node.getAttribute('id');
                    const newId = mapId(originalId);
                    if (newId) {
                      node.setAttribute('id', newId);
                    }
                  }
                }
                
                // Clone and append the node
                const clone = node.cloneNode(true);
                
                // Update all ID references in this node and its children
                updateIdReferences(clone);
                
                target.appendChild(clone);
              }
            }
          }
          
          // Copy all necessary attributes from source SVG
          const attributesToCopy = ['style', 'class', 'xmlns:xlink'];
          attributesToCopy.forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          });
          
          // Copy children from source SVG to group
          copyChildNodes(svgElement, group);
          
          // Add the group to the root SVG
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
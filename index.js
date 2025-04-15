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
    
    // Set fixed dimensions as requested for background and content
    const minX = -150;
    const maxX = 1050;  // Updated to 1050 as per latest instruction
    const minY = 0;
    const maxY = 600;   // Updated to 600 as per latest instruction
    
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;
    
    // Create the root SVG with fixed dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Create a background element
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', minX.toString());
    backgroundRect.setAttribute('y', minY.toString());
    backgroundRect.setAttribute('width', svgWidth.toString());
    backgroundRect.setAttribute('height', svgHeight.toString());
    backgroundRect.setAttribute('fill', 'transparent'); // Use transparent to make it invisible but still define the area
    rootElement.appendChild(backgroundRect);
    
    // Create a defs element to store shared elements for the entire SVG
    const globalDefs = rootSvg.createElement('defs');
    rootElement.appendChild(globalDefs);
    
    // Process each layout item
    for (const item of layout) {
      try {
        let content;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          content = await response.text();
          
          // Only process if it's SVG content
          if (!content.includes('<svg') && item.type === 'svg') {
            throw new Error(`Content from ${item.url} is not valid SVG`);
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
          content = fileContent.toString('utf8');
          
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          content = fileContent.toString('utf8');
          
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process content based on type - now only handling SVGs directly
        if (item.type === 'svg') {
          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          // Generate unique ID prefix for this item to prevent ID collisions
          const idPrefix = `svg-${item.id}-`;
          
          // Create a group for this SVG item
          const group = rootSvg.createElement('g');
          group.setAttribute('id', `group-${item.id}`);
          group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
          
          // Get SVG dimensions for scaling
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
          
          // Extract and update all CSS styles to preserve animations
          const styleElements = svgElement.getElementsByTagName('style');
          if (styleElements.length > 0) {
            for (let i = 0; i < styleElements.length; i++) {
              const style = styleElements[i];
              let cssText = style.textContent;
              
              // Update CSS selectors to include the item's ID prefix to avoid collisions
              // This is a simplified approach - a more robust CSS parser would be needed for complex cases
              cssText = cssText.replace(/([#.][a-zA-Z0-9_-]+)/g, `#group-${item.id} $1`);
              
              // Create a new style element in the root SVG
              const newStyle = rootSvg.createElement('style');
              newStyle.textContent = cssText;
              rootElement.appendChild(newStyle);
            }
          }
          
          // Process <defs> elements - move to global defs to maintain references
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              
              // Process each child of the defs element
              for (let j = 0; j < defs.childNodes.length; j++) {
                const node = defs.childNodes[j];
                if (node.nodeType === 1) { // Element node
                  // Create a clone to add to the global defs
                  const clone = node.cloneNode(true);
                  
                  // Update IDs to prevent collisions
                  if (clone.hasAttribute('id')) {
                    const oldId = clone.getAttribute('id');
                    const newId = idPrefix + oldId;
                    clone.setAttribute('id', newId);
                    
                    // Find all references to this ID in the SVG and update them
                    updateIdReferences(svgElement, oldId, newId);
                  }
                  
                  globalDefs.appendChild(clone);
                }
              }
            }
          }
          
          // Function to update all ID references in the SVG
          function updateIdReferences(element, oldId, newId) {
            // Look for url(#id) patterns in attributes
            const urlPattern = new RegExp(`url\\(#${oldId}\\)`, 'g');
            const attrs = ['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'];
            
            // Process all elements recursively
            function processNode(node) {
              if (node.nodeType === 1) { // Element node
                // Check attributes for url references
                for (const attr of attrs) {
                  if (node.hasAttribute(attr)) {
                    const value = node.getAttribute(attr);
                    if (value.includes(`url(#${oldId})`)) {
                      node.setAttribute(attr, value.replace(urlPattern, `url(#${newId})`));
                    }
                  }
                }
                
                // Check href/xlink:href attributes
                if (node.hasAttribute('href') && node.getAttribute('href') === `#${oldId}`) {
                  node.setAttribute('href', `#${newId}`);
                }
                if (node.hasAttribute('xlink:href') && node.getAttribute('xlink:href') === `#${oldId}`) {
                  node.setAttribute('xlink:href', `#${newId}`);
                }
                
                // Process child nodes
                for (let i = 0; i < node.childNodes.length; i++) {
                  processNode(node.childNodes[i]);
                }
              }
            }
            
            processNode(element);
          }
          
          // Copy all child nodes to the group, excluding defs and style which we've already processed
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'defs' && node.nodeName !== 'style') {
              const clone = node.cloneNode(true);
              group.appendChild(clone);
            }
          }
          
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // For actual images, we need to convert them to inline SVG objects
          // This would require parsing the image data and converting to inline SVG
          core.warning(`Image type (${item.type}) conversion to inline SVG not supported. Item ${item.id} will be skipped.`);
          
          // If you really want to include images, you'd need to convert them to an SVG-compatible format
          // For example, by tracing bitmap images or converting them to paths
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
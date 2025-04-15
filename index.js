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
    
    // Set fixed dimensions for background and viewBox
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
        let isSvgContent = false;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          // For SVG type, fetch the actual SVG source
          if (item.type === 'svg') {
            content = await response.text();
            isSvgContent = true;
            
            // Quick validation that it's really SVG content
            if (!content.includes('<svg') || !content.includes('</svg>')) {
              core.warning(`Content from ${item.url} doesn't appear to be valid SVG. Will treat as image.`);
              isSvgContent = false;
              
              // Convert to data URL as fallback
              const buffer = await response.arrayBuffer();
              const base64 = Buffer.from(buffer).toString('base64');
              const mimeType = response.headers.get('content-type') || 'image/svg+xml';
              content = `data:${mimeType};base64,${base64}`;
            }
          } else {
            // For non-SVG types, use data URL
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = response.headers.get('content-type') || 'image/png';
            content = `data:${mimeType};base64,${base64}`;
          }
        } else if (item.url.startsWith('blob:')) {
          // Local file - read from disk
          const filePath = item.url.substring(5); // Remove 'blob:' prefix
          const imagePath = path.join('images', filePath);
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          
          if (item.type === 'svg') {
            content = fileContent.toString('utf8');
            isSvgContent = true;
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
            isSvgContent = true;
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            content = `data:${mimeType};base64,${base64}`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process based on content type
        if (isSvgContent) {
          // For SVG content, we want to extract elements and inline them
          
          try {
            // Create a temporary unique ID for this group to avoid collision with other SVGs
            const groupId = `svg-group-${Math.random().toString(36).substring(2, 9)}`;
            
            // Parse SVG content
            const svgDoc = parser.parseFromString(content, 'image/svg+xml');
            const svgElement = svgDoc.documentElement;
            
            // Create a group element to contain the SVG content
            const group = rootSvg.createElement('g');
            group.setAttribute('id', groupId);
            
            // Set the transform to position and scale the SVG
            let transformValue = `translate(${item.x}, ${item.y})`;
            
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
              transformValue = `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`;
            }
            
            group.setAttribute('transform', transformValue);
            
            // Copy important attributes from the source SVG element
            const attributesToCopy = ['style', 'class', 'fill'];
            attributesToCopy.forEach(attr => {
              if (svgElement.hasAttribute(attr)) {
                group.setAttribute(attr, svgElement.getAttribute(attr));
              }
            });
            
            // Process <defs> separately to maintain animations, gradients, etc.
            const defsElements = svgElement.getElementsByTagName('defs');
            const allDefs = [];
            
            if (defsElements.length > 0) {
              // Create a container for all defs from this SVG
              const mergedDefs = rootSvg.createElement('defs');
              mergedDefs.setAttribute('data-source', groupId);
              
              for (let i = 0; i < defsElements.length; i++) {
                const defs = defsElements[i];
                
                // Copy all children of each defs element
                for (let j = 0; j < defs.childNodes.length; j++) {
                  const defsNode = defs.childNodes[j];
                  if (defsNode.nodeType === 1) { // Element node
                    // Add a prefix to IDs to avoid conflicts
                    if (defsNode.hasAttribute('id')) {
                      const originalId = defsNode.getAttribute('id');
                      const newId = `${groupId}-${originalId}`;
                      defsNode.setAttribute('id', newId);
                      allDefs.push({ originalId, newId });
                    }
                    mergedDefs.appendChild(defsNode.cloneNode(true));
                  }
                }
              }
              
              rootElement.appendChild(mergedDefs);
            }
            
            // Process and add all other elements
            for (let i = 0; i < svgElement.childNodes.length; i++) {
              const node = svgElement.childNodes[i];
              
              // Skip defs elements as we've already handled them
              if (node.nodeName.toLowerCase() !== 'defs') {
                // Clone the node so we can modify it
                const clonedNode = node.cloneNode(true);
                
                // Update references to defs IDs if needed
                if (allDefs.length > 0) {
                  updateReferences(clonedNode, allDefs);
                }
                
                group.appendChild(clonedNode);
              }
            }
            
            // Add the complete group to the root SVG
            rootElement.appendChild(group);
            
          } catch (svgError) {
            core.warning(`Error processing SVG ${item.url}: ${svgError.message}. Falling back to image.`);
            
            // Fallback to image if SVG processing fails
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            
            if (content.startsWith('data:')) {
              imageElement.setAttribute('href', content);
            } else {
              imageElement.setAttribute('href', item.url);
            }
            
            rootElement.appendChild(imageElement);
          }
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
    
    // Helper function to update references in SVG elements
    function updateReferences(node, idMappings) {
      if (!node || node.nodeType !== 1) return;
      
      // Update attributes that might reference IDs
      const refAttributes = ['href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'];
      
      refAttributes.forEach(attr => {
        if (node.hasAttribute(attr)) {
          let value = node.getAttribute(attr);
          
          idMappings.forEach(mapping => {
            // Replace references like "url(#id)" or "#id"
            value = value.replace(`url(#${mapping.originalId})`, `url(#${mapping.newId})`)
                         .replace(`#${mapping.originalId}`, `#${mapping.newId}`);
          });
          
          node.setAttribute(attr, value);
        }
      });
      
      // Update style attribute that might contain url references
      if (node.hasAttribute('style')) {
        let styleValue = node.getAttribute('style');
        
        idMappings.forEach(mapping => {
          styleValue = styleValue.replace(`url(#${mapping.originalId})`, `url(#${mapping.newId})`)
                              .replace(`#${mapping.originalId}`, `#${mapping.newId}`);
        });
        
        node.setAttribute('style', styleValue);
      }
      
      // Recursively process child nodes
      if (node.childNodes) {
        for (let i = 0; i < node.childNodes.length; i++) {
          updateReferences(node.childNodes[i], idMappings);
        }
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
        // Additional important plugins for animation preservation
        {
          name: 'removeXMLNS',
          active: false
        },
        {
          name: 'cleanupIDs',
          active: false
        }
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
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
    
    // Set fixed dimensions as requested
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;
    
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;
    
    // Create the root SVG with fixed dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}">
         <style id="merged-styles"></style>
       </svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    const styleElement = rootSvg.getElementById('merged-styles');
    
    // Add a white background rectangle that spans the entire area
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', minX);
    backgroundRect.setAttribute('y', minY);
    backgroundRect.setAttribute('width', svgWidth);
    backgroundRect.setAttribute('height', svgHeight);
    backgroundRect.setAttribute('fill', 'white');
    rootElement.insertBefore(backgroundRect, styleElement.nextSibling);
    
    // Generate unique ID prefix for this run to avoid ID conflicts
    const idPrefix = `svg-${Date.now()}-${Math.floor(Math.random() * 10000)}-`;
    let idCounter = 0;
    
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
          
          if (item.type === 'svg') {
            content = await response.text();
          } else {
            // For images, we'll need the binary data as base64
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
          
          // Create a group to position the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('id', `${item.id || `component-${idCounter++}`}`);
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
          
          // Extract CSS styles from the SVG
          const styleNodes = svgElement.getElementsByTagName('style');
          if (styleNodes.length > 0) {
            for (let i = 0; i < styleNodes.length; i++) {
              const styleNode = styleNodes[i];
              let cssText = styleNode.textContent;
              
              // Add a namespace to the CSS selectors to avoid conflicts
              const uniquePrefix = `${idPrefix}${idCounter}`;
              cssText = namespaceCss(cssText, uniquePrefix);
              
              // Update id references in the SVG elements
              namespaceIds(svgElement, uniquePrefix);
              
              // Add the namespaced CSS to the root style element
              styleElement.textContent += `\n/* Styles from component ${item.id || idCounter} */\n${cssText}\n`;
            }
          }
          
          // Copy defs elements (filters, gradients, etc.) to root SVG
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            // Create a defs element in the root SVG if it doesn't exist
            let rootDefs = rootElement.getElementsByTagName('defs')[0];
            if (!rootDefs) {
              rootDefs = rootSvg.createElement('defs');
              rootElement.insertBefore(rootDefs, rootElement.firstChild);
            }
            
            for (let i = 0; i < defsElements.length; i++) {
              const defsNode = defsElements[i];
              for (let j = 0; j < defsNode.childNodes.length; j++) {
                const defChild = defsNode.childNodes[j];
                if (defChild.nodeType === 1) { // Only process element nodes
                  // Namespace the IDs to avoid conflicts
                  const uniquePrefix = `${idPrefix}${idCounter}`;
                  namespaceIds(defChild, uniquePrefix);
                  rootDefs.appendChild(defChild.cloneNode(true));
                }
              }
            }
          }
          
          // Copy all child nodes to our group except style and defs
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'style' && node.nodeName !== 'defs') {
              const clone = node.cloneNode(true);
              
              // Namespace the clone to avoid ID conflicts
              const uniquePrefix = `${idPrefix}${idCounter}`;
              namespaceIds(clone, uniquePrefix);
              
              group.appendChild(clone);
            }
          }
          
          rootElement.appendChild(group);
          idCounter++;
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', item.id || `image-${idCounter++}`);
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
    
    // Function to namespace CSS selectors to avoid conflicts
    function namespaceCss(cssText, prefix) {
      // This is a simplified approach - a more robust solution would use a CSS parser
      return cssText.replace(/([^\r\n,{}]+)(,(?=[^}]*{)|\s*{)/g, function(match, selector, delimiter) {
        // Skip selectors that start with @ (like @keyframes)
        if (selector.trim().startsWith('@')) {
          return match;
        }
        
        // Split the selector by commas and namespace each part
        const parts = selector.split(',');
        const namespacedParts = parts.map(part => {
          // If the selector references an ID, namespace the ID
          if (part.includes('#')) {
            return part.replace(/#([a-zA-Z0-9\-_]+)/g, `#${prefix}-$1`);
          }
          // If it's a class, we could namespace it too, but for simplicity, we'll keep it as is
          return part;
        });
        
        return namespacedParts.join(',') + delimiter;
      });
    }
    
    // Function to namespace IDs in SVG elements
    function namespaceIds(element, prefix) {
      if (!element || element.nodeType !== 1) return;
      
      // Update element ID if it exists
      if (element.hasAttribute('id')) {
        const oldId = element.getAttribute('id');
        const newId = `${prefix}-${oldId}`;
        element.setAttribute('id', newId);
        
        // Also update any references to this ID in the same document
        updateIdReferences(rootElement, oldId, newId);
      }
      
      // Process child elements recursively
      for (let i = 0; i < element.childNodes.length; i++) {
        namespaceIds(element.childNodes[i], prefix);
      }
    }
    
    // Function to update references to namespaced IDs
    function updateIdReferences(element, oldId, newId) {
      if (!element || element.nodeType !== 1) return;
      
      // Check attributes that commonly reference IDs
      const refAttributes = ['href', 'xlink:href', 'url', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'];
      
      refAttributes.forEach(attr => {
        if (element.hasAttribute(attr)) {
          const value = element.getAttribute(attr);
          // Replace URL references like url(#id) or #id
          if (value.includes(`#${oldId}`)) {
            element.setAttribute(attr, value.replace(`#${oldId}`, `#${newId}`));
          }
        }
      });
      
      // Process child elements recursively
      for (let i = 0; i < element.childNodes.length; i++) {
        updateIdReferences(element.childNodes[i], oldId, newId);
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
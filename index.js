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
    const maxX = 850;
    const minY = 0;
    const maxY = 250;
    
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;
    
    // Create the root SVG with fixed dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Create a defs section in the root SVG for shared definitions
    const rootDefs = rootSvg.createElement('defs');
    rootElement.appendChild(rootDefs);
    
    // Track used IDs to avoid conflicts
    const usedIds = new Set();
    
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
            // For non-SVG images, use base64 encoding
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = response.headers.get('content-type') || 'image/png';
            content = `data:${mimeType};base64,${base64}`;
          }
        } else if (item.url.startsWith('blob:')) {
          // Local file with blob: prefix
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
            // For non-SVG images, use base64 encoding
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
            // For non-SVG images, use base64 encoding
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
          
          // Create a unique ID prefix for this SVG to avoid conflicts
          const idPrefix = `svg_${item.id.replace(/[^a-zA-Z0-9]/g, '_')}_`;
          
          // Handle defs elements (gradients, animations, etc.)
          const defsElements = svgElement.getElementsByTagName('defs');
          
          // Process all defs sections and rewrite IDs to avoid conflicts
          if (defsElements.length > 0) {
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              
              // For each child in defs, process IDs
              for (let j = 0; j < defs.childNodes.length; j++) {
                const node = defs.childNodes[j];
                if (node.nodeType === 1) { // Element node
                  // Rewrite ID if present
                  if (node.hasAttribute('id')) {
                    const oldId = node.getAttribute('id');
                    const newId = `${idPrefix}${oldId}`;
                    node.setAttribute('id', newId);
                    usedIds.add(newId);
                  }
                }
              }
              
              // Move defs children to root defs
              while (defs.firstChild) {
                rootDefs.appendChild(defs.firstChild);
              }
            }
          }
          
          // Create a group to position and scale the SVG
          const group = rootSvg.createElement('g');
          
          // Get original SVG dimensions
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
          
          // Apply position and scale
          const scaleX = item.width / svgWidth;
          const scaleY = item.height / svgHeight;
          group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
          
          // Copy important attributes from the source SVG
          ['style', 'class'].forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          });
          
          // Function to process a node and its children for ID references
          const processNode = (node) => {
            if (node.nodeType !== 1) return node; // Not an element node
            
            // Clone the node
            const clone = node.cloneNode(false);
            
            // Process attributes for ID references
            const idRefAttributes = ['href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-end', 'marker-mid'];
            
            for (const attr of idRefAttributes) {
              if (node.hasAttribute(attr)) {
                let value = node.getAttribute(attr);
                
                // Check if the attribute value is an ID reference
                if (value.startsWith('#')) {
                  const refId = value.substring(1);
                  const newRefId = `${idPrefix}${refId}`;
                  clone.setAttribute(attr, `#${newRefId}`);
                } else {
                  clone.setAttribute(attr, value);
                }
              }
            }
            
            // Process other attributes
            const attrs = node.attributes;
            if (attrs) {
              for (let i = 0; i < attrs.length; i++) {
                const attr = attrs[i];
                const name = attr.name;
                const value = attr.value;
                
                // Skip attributes we've already processed
                if (idRefAttributes.includes(name)) continue;
                
                // Handle ID attribute specially
                if (name === 'id') {
                  const newId = `${idPrefix}${value}`;
                  clone.setAttribute('id', newId);
                  usedIds.add(newId);
                } else {
                  clone.setAttribute(name, value);
                }
              }
            }
            
            // Process children
            for (let i = 0; i < node.childNodes.length; i++) {
              const childNode = node.childNodes[i];
              const processedChild = processNode(childNode);
              if (processedChild) {
                clone.appendChild(processedChild);
              }
            }
            
            return clone;
          };
          
          // Process and add each child of the SVG element (except defs which we've already handled)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'defs') {
              const processedNode = processNode(node);
              if (processedNode) {
                group.appendChild(processedNode);
              }
            }
          }
          
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
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
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
    
    // Set fixed dimensions including background
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
        let svgContent;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          // For SVG type, we want the actual SVG content
          if (item.type === 'svg') {
            svgContent = await response.text();
          } else {
            // For images, we need to create an SVG wrapper with an image element
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = response.headers.get('content-type') || 'image/png';
            const dataUrl = `data:${mimeType};base64,${base64}`;
            
            // Create an SVG with an embedded image
            svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
              <image width="${item.width}" height="${item.height}" href="${dataUrl}" />
            </svg>`;
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
            svgContent = fileContent.toString('utf8');
          } else {
            // For images, create an SVG wrapper
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            const dataUrl = `data:${mimeType};base64,${base64}`;
            
            svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
              <image width="${item.width}" height="${item.height}" href="${dataUrl}" />
            </svg>`;
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
            svgContent = fileContent.toString('utf8');
          } else {
            // For images, create an SVG wrapper
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            const dataUrl = `data:${mimeType};base64,${base64}`;
            
            svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}">
              <image width="${item.width}" height="${item.height}" href="${dataUrl}" />
            </svg>`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Parse the SVG content
        const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
        const svgElement = svgDoc.documentElement;
        
        // Defs collection to store across all SVGs
        const defsCollection = new Map();
        
        // Extract all defs elements with their IDs from the SVG
        const extractDefs = (element) => {
          const defsElements = element.getElementsByTagName('defs');
          for (let i = 0; i < defsElements.length; i++) {
            const defs = defsElements[i];
            for (let j = 0; j < defs.childNodes.length; j++) {
              const child = defs.childNodes[j];
              if (child.nodeType === 1) { // Element node
                if (child.hasAttribute('id')) {
                  const id = child.getAttribute('id');
                  // Create a unique ID to avoid conflicts
                  const uniqueId = `${item.id || 'item'}-${id}`;
                  child.setAttribute('id', uniqueId);
                  defsCollection.set(uniqueId, child.cloneNode(true));
                  
                  // Also update any references to this ID within the SVG
                  updateReferences(svgElement, id, uniqueId);
                } else {
                  // Add elements without IDs too
                  defsCollection.set(`${item.id || 'item'}-def-${j}`, child.cloneNode(true));
                }
              }
            }
          }
        };
        
        // Update references to IDs within the SVG (used for animations, gradients, etc.)
        const updateReferences = (element, oldId, newId) => {
          // Common attributes that might reference IDs
          const refAttributes = ['href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'];
          
          // Process the element itself
          for (const attr of refAttributes) {
            if (element.hasAttribute(attr)) {
              let value = element.getAttribute(attr);
              // Check for URL references like "url(#id)"
              if (value.includes(`url(#${oldId})`)) {
                value = value.replace(`url(#${oldId})`, `url(#${newId})`);
                element.setAttribute(attr, value);
              }
              // Check for direct references like "#id"
              else if (value === `#${oldId}`) {
                element.setAttribute(attr, `#${newId}`);
              }
            }
          }
          
          // Process child elements recursively
          for (let i = 0; i < element.childNodes.length; i++) {
            const child = element.childNodes[i];
            if (child.nodeType === 1) { // Element node
              updateReferences(child, oldId, newId);
            }
          }
        };
        
        // Extract all defs for later insertion
        extractDefs(svgElement);
        
        // Create group element for positioning
        const group = rootSvg.createElement('g');
        
        // Handle SVG attributes and dimensions
        let origWidth, origHeight;
        
        if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
          origWidth = parseFloat(svgElement.getAttribute('width'));
          origHeight = parseFloat(svgElement.getAttribute('height'));
        } else if (svgElement.hasAttribute('viewBox')) {
          const viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/);
          origWidth = parseFloat(viewBox[2]);
          origHeight = parseFloat(viewBox[3]);
        } else {
          // Default dimensions
          origWidth = item.width;
          origHeight = item.height;
        }
        
        // Set transform for positioning and scaling
        const scaleX = item.width / origWidth;
        const scaleY = item.height / origHeight;
        group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
        
        // Copy important attributes from source SVG
        const attributesToCopy = ['style', 'class'];
        attributesToCopy.forEach(attr => {
          if (svgElement.hasAttribute(attr)) {
            group.setAttribute(attr, svgElement.getAttribute(attr));
          }
        });
        
        // Copy all non-defs child nodes from the SVG
        for (let i = 0; i < svgElement.childNodes.length; i++) {
          const child = svgElement.childNodes[i];
          if (child.nodeName !== 'defs') {
            group.appendChild(child.cloneNode(true));
          }
        }
        
        // Add the group to the root SVG
        rootElement.appendChild(group);
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }
    
    // Add all collected defs to the root SVG
    const defsList = Array.from(defsCollection.values());
    if (defsList.length > 0) {
      const defs = rootSvg.createElement('defs');
      defsList.forEach(def => {
        defs.appendChild(def);
      });
      // Insert defs as the first child
      rootElement.insertBefore(defs, rootElement.firstChild);
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

// Define defs collection in a higher scope so it's accessible
const defsCollection = new Map();

run();
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
    
    // Set fixed dimensions as requested for the background
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
    
    // Add a background area marker (transparent rect) to define the boundaries
    const bgRect = rootSvg.createElement('rect');
    bgRect.setAttribute('x', minX.toString());
    bgRect.setAttribute('y', minY.toString());
    bgRect.setAttribute('width', svgWidth.toString());
    bgRect.setAttribute('height', svgHeight.toString());
    bgRect.setAttribute('fill', 'none'); // Transparent background
    rootElement.appendChild(bgRect);
    
    // Process each layout item
    for (const item of layout) {
      try {
        let content;
        let svgContent = null;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          const contentType = response.headers.get('content-type');
          
          if (item.type === 'svg' || contentType?.includes('svg')) {
            // Get the actual SVG source code
            svgContent = await response.text();
          } else {
            // For images, we'll need the binary data as base64
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || 'image/png';
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
            svgContent = fileContent.toString('utf8');
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
            svgContent = fileContent.toString('utf8');
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
        if (item.type === 'svg' && svgContent) {
          // Parse the real SVG content
          const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          // Create a group to position the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('id', item.id || `item-${layout.indexOf(item)}`);
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
          
          // Extract all namespace declarations from source SVG to maintain proper references
          for (let i = 0; i < svgElement.attributes.length; i++) {
            const attr = svgElement.attributes[i];
            if (attr.name.startsWith('xmlns:') && !rootElement.hasAttribute(attr.name)) {
              rootElement.setAttribute(attr.name, attr.value);
            }
          }
          
          // Extract and copy all defs (important for animations, gradients, etc.)
          // We'll add them to the root SVG to ensure proper scope
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            // Look for existing defs in the root SVG
            let rootDefs = null;
            const rootDefsElements = rootElement.getElementsByTagName('defs');
            
            if (rootDefsElements.length > 0) {
              rootDefs = rootDefsElements[0];
            } else {
              // Create a new defs element if none exists
              rootDefs = rootSvg.createElement('defs');
              rootElement.insertBefore(rootDefs, rootElement.firstChild);
            }
            
            // Copy all defs content to the root defs
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              for (let j = 0; j < defs.childNodes.length; j++) {
                const defNode = defs.childNodes[j];
                const clone = defNode.cloneNode(true);
                // Add a prefix to IDs to avoid conflicts
                if (clone.nodeType === 1 && clone.hasAttribute('id')) {
                  const originalId = clone.getAttribute('id');
                  const newId = `${item.id || 'item'}-${originalId}`;
                  clone.setAttribute('id', newId);
                  
                  // Find all references to this ID in the SVG and update them
                  updateIdReferences(svgElement, originalId, newId);
                }
                rootDefs.appendChild(clone);
              }
            }
          }
          
          // Copy all styles into the root SVG
          const styleElements = svgElement.getElementsByTagName('style');
          if (styleElements.length > 0) {
            for (let i = 0; i < styleElements.length; i++) {
              const style = styleElements[i];
              const clone = style.cloneNode(true);
              rootElement.appendChild(clone);
            }
          }
          
          // Copy all direct child nodes from the SVG to our group (excluding defs and styles)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'defs' && node.nodeName !== 'style') {
              group.appendChild(node.cloneNode(true));
            }
          }
          
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', item.id || `item-${layout.indexOf(item)}`);
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
    
    // Helper function to update ID references in the SVG
    function updateIdReferences(element, oldId, newId) {
      // Update references in all attributes that might contain URLs
      const urlAttributes = ['href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'];
      
      const allElements = element.getElementsByTagName('*');
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        
        for (const attr of urlAttributes) {
          if (el.hasAttribute(attr)) {
            const value = el.getAttribute(attr);
            if (value === `#${oldId}` || value.includes(`url(#${oldId})`)) {
              const newValue = value.replace(`#${oldId}`, `#${newId}`).replace(`url(#${oldId})`, `url(#${newId})`);
              el.setAttribute(attr, newValue);
            }
          }
        }
        
        // Check for animation targets
        if (el.nodeName.includes('animate') && el.hasAttribute('xlink:href')) {
          const value = el.getAttribute('xlink:href');
          if (value === `#${oldId}`) {
            el.setAttribute('xlink:href', `#${newId}`);
          }
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
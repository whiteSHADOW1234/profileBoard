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
    
    // Set fixed dimensions for the SVG canvas and background
    const minX = -150;
    const maxX = 1050; // Extended to 1050 as requested
    const minY = 0;
    const maxY = 600; // Extended to 600 as requested
    
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;
    
    // Create the root SVG with fixed dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Add background rectangle
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', minX.toString());
    backgroundRect.setAttribute('y', minY.toString());
    backgroundRect.setAttribute('width', svgWidth.toString());
    backgroundRect.setAttribute('height', svgHeight.toString());
    backgroundRect.setAttribute('fill', 'white');
    rootElement.appendChild(backgroundRect);
    
    // Process each layout item
    for (const item of layout) {
      try {
        let svgDoc;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          const content = await response.text();
          
          if (item.type === 'svg') {
            // Parse SVG content
            svgDoc = parser.parseFromString(content, 'image/svg+xml');
          } else {
            // For non-SVG content, we'll create an image element
            // But still use SVG source if available (for GitHub badges etc. that return SVG)
            try {
              svgDoc = parser.parseFromString(content, 'image/svg+xml');
              // Check if it's valid SVG by checking root element
              if (!svgDoc.documentElement || svgDoc.documentElement.nodeName !== 'svg') {
                throw new Error('Not valid SVG');
              }
              // If we get here, it's valid SVG despite item.type not being 'svg'
              core.info(`URL returns SVG content despite type being ${item.type}. Using SVG.`);
            } catch (e) {
              // Not SVG, convert to base64 and create image element
              const imageResponse = await fetch(item.url);
              const buffer = await imageResponse.arrayBuffer();
              const base64 = Buffer.from(buffer).toString('base64');
              const mimeType = imageResponse.headers.get('content-type') || 'image/png';
              
              // Create a simple SVG with an image element
              const imageWrapper = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${item.width}" height="${item.height}">
                <image width="${item.width}" height="${item.height}" xlink:href="data:${mimeType};base64,${base64}" />
              </svg>`;
              svgDoc = parser.parseFromString(imageWrapper, 'image/svg+xml');
            }
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
            const content = fileContent.toString('utf8');
            svgDoc = parser.parseFromString(content, 'image/svg+xml');
          } else {
            // For non-SVG, create an image wrapper SVG
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            
            const imageWrapper = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${item.width}" height="${item.height}">
              <image width="${item.width}" height="${item.height}" xlink:href="data:${mimeType};base64,${base64}" />
            </svg>`;
            svgDoc = parser.parseFromString(imageWrapper, 'image/svg+xml');
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
            const content = fileContent.toString('utf8');
            svgDoc = parser.parseFromString(content, 'image/svg+xml');
          } else {
            // For non-SVG, create an image wrapper SVG
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            
            const imageWrapper = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${item.width}" height="${item.height}">
              <image width="${item.width}" height="${item.height}" xlink:href="data:${mimeType};base64,${base64}" />
            </svg>`;
            svgDoc = parser.parseFromString(imageWrapper, 'image/svg+xml');
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // At this point, svgDoc contains the parsed SVG document for any content type
        const svgElement = svgDoc.documentElement;
        
        // Create a group to position and scale the SVG
        const group = rootSvg.createElement('g');
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
        
        // Copy necessary attributes from source SVG for animations
        const attributesToCopy = ['style', 'class'];
        attributesToCopy.forEach(attr => {
          if (svgElement.hasAttribute(attr)) {
            group.setAttribute(attr, svgElement.getAttribute(attr));
          }
        });
        
        // Create namespace prefixes map to properly handle namespaces
        const namespaces = {};
        const attributes = svgElement.attributes;
        for (let i = 0; i < attributes.length; i++) {
          const attr = attributes[i];
          if (attr.name.startsWith('xmlns:')) {
            const prefix = attr.name.substring(6);
            namespaces[prefix] = attr.value;
            
            // Add namespace declaration to the root SVG if not already present
            if (!rootElement.hasAttribute(attr.name)) {
              rootElement.setAttribute(attr.name, attr.value);
            }
          }
        }
        
        // Extract and copy all defs (important for animations, gradients, etc.)
        const defsElements = svgElement.getElementsByTagName('defs');
        const defsGroup = rootSvg.createElement('defs');
        
        if (defsElements.length > 0) {
          // Create unique prefix for IDs to prevent conflicts
          const idPrefix = `item-${item.id}-`.replace(/[^a-zA-Z0-9]/g, '-');
          
          for (let i = 0; i < defsElements.length; i++) {
            const defs = defsElements[i];
            
            // Process children of defs and fix IDs
            for (let j = 0; j < defs.childNodes.length; j++) {
              const child = defs.childNodes[j];
              if (child.nodeType === 1) { // Element nodes only
                const clone = child.cloneNode(true);
                
                // Update IDs in the cloned element
                if (clone.hasAttribute('id')) {
                  const oldId = clone.getAttribute('id');
                  const newId = `${idPrefix}${oldId}`;
                  clone.setAttribute('id', newId);
                  
                  // Also need to update references to this ID in the entire SVG
                  updateReferences(svgElement, oldId, newId);
                }
                
                defsGroup.appendChild(clone);
              }
            }
          }
          
          // Add defs if it has children
          if (defsGroup.hasChildNodes()) {
            rootElement.appendChild(defsGroup);
          }
        }
        
        // Copy all child nodes to maintain structure and animations
        for (let i = 0; i < svgElement.childNodes.length; i++) {
          const node = svgElement.childNodes[i];
          // Skip defs nodes as they have already been processed
          if (node.nodeName !== 'defs') {
            group.appendChild(node.cloneNode(true));
          }
        }
        
        rootElement.appendChild(group);
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }
    
    // Function to update references to IDs within the SVG
    function updateReferences(element, oldId, newId) {
      const attributes = ['href', 'xlink:href', 'url', 'fill', 'stroke', 'filter', 'mask', 'clip-path'];
      
      // Process all elements in the SVG
      const allElements = element.getElementsByTagName('*');
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        
        // Check each attribute that might contain references
        for (const attr of attributes) {
          if (el.hasAttribute(attr)) {
            let value = el.getAttribute(attr);
            
            // Update URL references like url(#id)
            if (value.includes(`url(#${oldId})`)) {
              value = value.replace(`url(#${oldId})`, `url(#${newId})`);
              el.setAttribute(attr, value);
            }
            // Update direct references like #id
            else if (value === `#${oldId}`) {
              el.setAttribute(attr, `#${newId}`);
            }
          }
        }
        
        // Process style attribute which might contain url references
        if (el.hasAttribute('style')) {
          let style = el.getAttribute('style');
          if (style.includes(`url(#${oldId})`)) {
            style = style.replace(`url(#${oldId})`, `url(#${newId})`);
            el.setAttribute('style', style);
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
              // Disable plugins that might break inlined SVGs or animations
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
              // Critical for animations and SVG references
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
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
    
    // Set fixed dimensions for the SVG including background
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
    
    // Add background as the first element
    const backgroundRect = rootSvg.createElement('rect');
    backgroundRect.setAttribute('x', minX.toString());
    backgroundRect.setAttribute('y', minY.toString());
    backgroundRect.setAttribute('width', svgWidth.toString());
    backgroundRect.setAttribute('height', svgHeight.toString());
    backgroundRect.setAttribute('fill', 'white');
    rootElement.appendChild(backgroundRect);
    
    // Create a collection to store animation-related elements
    const defs = rootSvg.createElement('defs');
    rootElement.appendChild(defs);
    
    // Track used IDs to prevent conflicts
    const usedIds = new Set();
    
    // Helper function to make IDs unique
    function makeIdUnique(id, itemId) {
      if (!id) return null;
      
      const newId = `${itemId}_${id}`;
      usedIds.add(newId);
      return newId;
    }
    
    // Helper function to update ID references in attributes
    function updateIdReferences(element, oldId, newId) {
      // Common attributes that might reference IDs
      const idRefAttributes = [
        'href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start',
        'marker-mid', 'marker-end', 'begin', 'end', 'attributeName', 'by', 'from', 'to', 'values'
      ];
      
      // Check each attribute that might contain an ID reference
      for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        
        if (idRefAttributes.includes(attr.name)) {
          // Check for URL references like "url(#id)"
          if (attr.value.includes(`url(#${oldId})`)) {
            attr.value = attr.value.replace(`url(#${oldId})`, `url(#${newId})`);
          }
          // Check for direct ID references like "#id"
          else if (attr.value === `#${oldId}`) {
            attr.value = `#${newId}`;
          }
        }
        
        // Special case for animation references
        if (attr.value && attr.value.includes(oldId)) {
          // Update animation timing references like "id.begin+1s"
          if (attr.name === 'begin' || attr.name === 'end') {
            const regex = new RegExp(oldId + '(?=[.;])', 'g');
            attr.value = attr.value.replace(regex, newId);
          }
        }
      }
    }
    
    // Recursively process an element and its children to update ID references
    function processElementIds(element, itemId, idMap) {
      if (!element) return;
      
      // Process this element's ID if it has one
      if (element.hasAttribute && element.hasAttribute('id')) {
        const oldId = element.getAttribute('id');
        const newId = makeIdUnique(oldId, itemId);
        
        if (newId) {
          element.setAttribute('id', newId);
          idMap[oldId] = newId;
          
          // Update references to this ID in the element itself
          updateIdReferences(element, oldId, newId);
        }
      }
      
      // Process attributes that might reference IDs
      if (element.hasAttribute) {
        for (const [oldId, newId] of Object.entries(idMap)) {
          updateIdReferences(element, oldId, newId);
        }
      }
      
      // Process child elements recursively
      if (element.childNodes) {
        for (let i = 0; i < element.childNodes.length; i++) {
          processElementIds(element.childNodes[i], itemId, idMap);
        }
      }
    }
    
    // Process each layout item
    for (const item of layout) {
      try {
        let svgContent;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching SVG from URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          const contentType = response.headers.get('content-type');
          
          if (item.type === 'svg') {
            // Get raw SVG content
            svgContent = await response.text();
            
            // Sometimes APIs return JSON with SVG embedded - try to extract it
            if (contentType?.includes('application/json')) {
              try {
                const jsonData = JSON.parse(svgContent);
                // Check common fields where SVG might be
                if (jsonData.svg) svgContent = jsonData.svg;
                else if (jsonData.data) svgContent = jsonData.data;
                else if (jsonData.content) svgContent = jsonData.content;
              } catch (e) {
                // Not valid JSON or doesn't contain SVG, keep the original content
                core.info(`Response looks like JSON but couldn't extract SVG: ${e.message}`);
              }
            }
            
            // Handle case where content is a data URL
            if (svgContent.startsWith('data:image/svg+xml;base64,')) {
              const base64Data = svgContent.replace('data:image/svg+xml;base64,', '');
              svgContent = Buffer.from(base64Data, 'base64').toString('utf8');
            }
            
            // Make sure content is actually SVG
            if (!svgContent.trim().startsWith('<svg') && !svgContent.trim().startsWith('<?xml')) {
              throw new Error(`Content from ${item.url} is not valid SVG`);
            }
          } else {
            // For non-SVG images, convert to data URL for embedding
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || `image/${item.type}` || 'image/png';
            svgContent = `data:${mimeType};base64,${base64}`;
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
            // For non-SVG images, convert to data URL
            const base64 = fileContent.toString('base64');
            const mimeType = `image/${item.type}` || 'image/png';
            svgContent = `data:${mimeType};base64,${base64}`;
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
            // For non-SVG images, convert to data URL
            const base64 = fileContent.toString('base64');
            const mimeType = `image/${item.type}` || 'image/png';
            svgContent = `data:${mimeType};base64,${base64}`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process content based on type
        if (item.type === 'svg') {
          // Parse SVG content
          const svgDoc = parser.parseFromString(svgContent, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          // Create a group to position the SVG
          const group = rootSvg.createElement('g');
          group.setAttribute('id', `item_${item.id}`);
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
          
          // Map to store original ID to new ID mappings
          const idMap = {};
          
          // Extract <defs> elements and add them to root defs
          // Important for animations, gradients, filters, etc.
          const svgDefs = svgElement.getElementsByTagName('defs');
          if (svgDefs.length > 0) {
            for (let i = 0; i < svgDefs.length; i++) {
              const defElement = svgDefs[i];
              
              // Process all child nodes of defs
              for (let j = 0; j < defElement.childNodes.length; j++) {
                const defChild = defElement.childNodes[j];
                if (defChild.nodeType === 1) { // Element node
                  const clonedDef = defChild.cloneNode(true);
                  processElementIds(clonedDef, item.id, idMap);
                  defs.appendChild(clonedDef);
                }
              }
            }
          }
          
          // Extract <style> elements and add them to the group
          const styleElements = svgElement.getElementsByTagName('style');
          if (styleElements.length > 0) {
            for (let i = 0; i < styleElements.length; i++) {
              const styleElement = styleElements[i];
              const clonedStyle = styleElement.cloneNode(true);
              // Update selectors in CSS if needed
              if (clonedStyle.textContent) {
                let cssText = clonedStyle.textContent;
                for (const [oldId, newId] of Object.entries(idMap)) {
                  const idSelector = `#${oldId}`;
                  const newSelector = `#${newId}`;
                  cssText = cssText.replace(new RegExp(idSelector, 'g'), newSelector);
                }
                clonedStyle.textContent = cssText;
              }
              group.appendChild(clonedStyle);
            }
          }
          
          // Copy all animation-related attributes from source SVG
          const animationAttrs = ['onload', 'class', 'style'];
          animationAttrs.forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          });
          
          // Copy all child nodes (except defs and style which were handled separately)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            const nodeName = node.nodeName.toLowerCase();
            
            // Skip defs and style elements as they're already processed
            if (nodeName !== 'defs' && nodeName !== 'style') {
              const clonedNode = node.cloneNode(true);
              processElementIds(clonedNode, item.id, idMap);
              group.appendChild(clonedNode);
            }
          }
          
          // Add the group to the root SVG
          rootElement.appendChild(group);
          
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element for non-SVG content
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', `item_${item.id}`);
          imageElement.setAttribute('x', item.x);
          imageElement.setAttribute('y', item.y);
          imageElement.setAttribute('width', item.width);
          imageElement.setAttribute('height', item.height);
          imageElement.setAttribute('href', svgContent);
          
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
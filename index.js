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
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Process each layout item
    for (const item of layout) {
      try {
        let content;
        let isInlineSvg = false;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          const contentType = response.headers.get('content-type');
          
          // Check if the content is SVG based on response headers
          if (contentType && contentType.includes('svg')) {
            content = await response.text();
            isInlineSvg = true;
          } else if (item.type === 'svg') {
            // Force SVG type if specified, regardless of content-type
            content = await response.text();
            isInlineSvg = true;
          } else {
            // For images, convert to data URI
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || 'image/png';
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
            isInlineSvg = true;
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
            isInlineSvg = true;
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
        if (isInlineSvg) {
          // Check if the content starts with XML declaration and remove it if needed
          if (content.trim().startsWith('<?xml')) {
            content = content.substring(content.indexOf('<svg'));
          }
          
          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          const svgElement = svgDoc.documentElement;
          
          if (!svgElement || svgElement.nodeName !== 'svg') {
            throw new Error(`Invalid SVG content from ${item.url}`);
          }
          
          // Get SVG dimensions for scaling
          let svgWidth, svgHeight;
          let viewBox = null;
          
          if (svgElement.hasAttribute('viewBox')) {
            viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/).map(Number);
            svgWidth = viewBox[2];
            svgHeight = viewBox[3];
          }
          
          if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
            svgWidth = parseFloat(svgElement.getAttribute('width').replace(/[^0-9.]/g, ''));
            svgHeight = parseFloat(svgElement.getAttribute('height').replace(/[^0-9.]/g, ''));
          } else if (!svgWidth || !svgHeight) {
            // Default dimensions if not specified
            svgWidth = item.width;
            svgHeight = item.height;
          }
          
          // Create a group element to contain the SVG content with proper positioning
          const group = rootSvg.createElement('g');
          
          // Determine scaling if needed
          const scaleX = svgWidth ? item.width / svgWidth : 1;
          const scaleY = svgHeight ? item.height / svgHeight : 1;
          
          // Apply transformation for position and scale
          let transform = `translate(${item.x}, ${item.y})`;
          if (scaleX !== 1 || scaleY !== 1) {
            transform += ` scale(${scaleX}, ${scaleY})`;
          }
          group.setAttribute('transform', transform);
          
          // Extract and copy all attributes from the source SVG except dimensional ones
          // This preserves things like classes, styles, and other attributes needed for animations
          const attributesToExclude = ['width', 'height', 'viewBox', 'xmlns', 'version'];
          for (let i = 0; i < svgElement.attributes.length; i++) {
            const attr = svgElement.attributes[i];
            if (!attributesToExclude.includes(attr.name)) {
              group.setAttribute(attr.name, attr.value);
            }
          }
          
          // Copy all defs to the root SVG to maintain references for animations
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            // Create a master defs in the root SVG if it doesn't exist
            let rootDefs = rootSvg.getElementsByTagName('defs')[0];
            if (!rootDefs) {
              rootDefs = rootSvg.createElement('defs');
              rootElement.appendChild(rootDefs);
            }
            
            // Copy all items from source defs to root defs
            for (let i = 0; i < defsElements.length; i++) {
              const sourceDefs = defsElements[i];
              // Prefix IDs to avoid conflicts
              const idPrefix = `item_${item.id.replace(/[^a-zA-Z0-9]/g, '')}_`;
              
              // Process each child of defs
              for (let j = 0; j < sourceDefs.childNodes.length; j++) {
                const node = sourceDefs.childNodes[j];
                const clonedNode = node.cloneNode(true);
                
                // Update IDs to avoid conflicts
                if (node.nodeType === 1) { // ELEMENT_NODE
                  if (node.hasAttribute('id')) {
                    const originalId = node.getAttribute('id');
                    const newId = idPrefix + originalId;
                    clonedNode.setAttribute('id', newId);
                    
                    // Update any references to this ID in the content
                    updateReferences(svgElement, originalId, newId);
                  }
                }
                
                rootDefs.appendChild(clonedNode);
              }
            }
          }
          
          // Copy all children of the source SVG to our group (except defs which we already processed)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'defs') {
              group.appendChild(node.cloneNode(true));
            }
          }
          
          // Helper function to update ID references in the SVG content
          function updateReferences(element, oldId, newId) {
            // Process url(#id) references in style attributes
            if (element.hasAttribute('style')) {
              const style = element.getAttribute('style');
              if (style.includes(`url(#${oldId})`)) {
                element.setAttribute('style', style.replace(new RegExp(`url\\(#${oldId}\\)`, 'g'), `url(#${newId})`));
              }
            }
            
            // Process href and xlink:href attributes
            if (element.hasAttribute('href') && element.getAttribute('href') === `#${oldId}`) {
              element.setAttribute('href', `#${newId}`);
            }
            if (element.hasAttribute('xlink:href') && element.getAttribute('xlink:href') === `#${oldId}`) {
              element.setAttribute('xlink:href', `#${newId}`);
            }
            
            // Process fill and stroke attributes
            if (element.hasAttribute('fill') && element.getAttribute('fill') === `url(#${oldId})`) {
              element.setAttribute('fill', `url(#${newId})`);
            }
            if (element.hasAttribute('stroke') && element.getAttribute('stroke') === `url(#${oldId})`) {
              element.setAttribute('stroke', `url(#${newId})`);
            }
            
            // Recursively process child elements
            for (let i = 0; i < element.childNodes.length; i++) {
              const child = element.childNodes[i];
              if (child.nodeType === 1) { // ELEMENT_NODE
                updateReferences(child, oldId, newId);
              }
            }
          }
          
          rootElement.appendChild(group);
        } else {
          // Handle image elements
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
        // Continue with other items rather than failing completely
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
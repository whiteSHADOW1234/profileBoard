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
    
    // Add all potential namespaces that might be needed for animations
    const rootElement = rootSvg.documentElement;
    rootElement.setAttribute('xmlns:svg', 'http://www.w3.org/2000/svg');
    rootElement.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    rootElement.setAttribute('xmlns:html', 'http://www.w3.org/1999/xhtml');
    
    // Create a counter for generating unique IDs
    let idCounter = 0;
    
    // Helper function to make IDs unique
    function makeIdsUnique(content, prefix) {
      const svgDoc = parser.parseFromString(content, 'image/svg+xml');
      const allElements = svgDoc.getElementsByTagName('*');
      const idMap = new Map();
      
      // First pass: find all elements with IDs and create new unique IDs
      for (let i = 0; i < allElements.length; i++) {
        const element = allElements[i];
        if (element.hasAttribute('id')) {
          const oldId = element.getAttribute('id');
          const newId = `${prefix}-${oldId}-${idCounter++}`;
          idMap.set(oldId, newId);
          element.setAttribute('id', newId);
        }
      }
      
      // Second pass: update all references to the IDs
      for (let i = 0; i < allElements.length; i++) {
        const element = allElements[i];
        const attributes = element.attributes;
        
        if (!attributes) continue;
        
        for (let j = 0; j < attributes.length; j++) {
          const attr = attributes[j];
          // Common attributes that might contain ID references
          if (['href', 'xlink:href', 'fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'].includes(attr.name)) {
            let value = attr.value;
            
            // Update URL references like url(#id)
            const urlRefs = value.match(/url\(#([^)]+)\)/g);
            if (urlRefs) {
              for (const urlRef of urlRefs) {
                const idRef = urlRef.match(/url\(#([^)]+)\)/)[1];
                if (idMap.has(idRef)) {
                  value = value.replace(`url(#${idRef})`, `url(#${idMap.get(idRef)})`);
                }
              }
              element.setAttribute(attr.name, value);
            }
            
            // Update direct references like #id
            if (value.startsWith('#')) {
              const idRef = value.substring(1);
              if (idMap.has(idRef)) {
                element.setAttribute(attr.name, `#${idMap.get(idRef)}`);
              }
            }
          }
          
          // Check for animation targets
          if (['begin', 'end', 'xlink:href'].includes(attr.name)) {
            let value = attr.value;
            
            // Handle direct ID references
            idMap.forEach((newId, oldId) => {
              // Handle various animation-related reference formats
              if (value === `#${oldId}`) {
                element.setAttribute(attr.name, `#${newId}`);
              } else if (value.includes(`${oldId}.`)) {
                value = value.replace(new RegExp(`${oldId}\\.`, 'g'), `${newId}.`);
                element.setAttribute(attr.name, value);
              } else if (value.includes(`${oldId};`)) {
                value = value.replace(new RegExp(`${oldId};`, 'g'), `${newId};`);
                element.setAttribute(attr.name, value);
              }
            });
          }
        }
      }
      
      return serializer.serializeToString(svgDoc);
    }
    
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
          
          const contentType = response.headers.get('content-type');
          
          if (item.type === 'svg' || (contentType && contentType.includes('svg'))) {
            content = await response.text();
            isSvgContent = true;
          } else {
            // For images, we'll need the binary data as base64
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            const mimeType = contentType || 'image/png';
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
        
        // Process content based on type
        if (isSvgContent || item.type === 'svg') {
          // Make IDs unique to avoid conflicts when merging SVGs
          const uniqueContent = makeIdsUnique(content, `item-${item.id || idCounter++}`);
          
          // Parse SVG content
          const svgDoc = parser.parseFromString(uniqueContent, 'image/svg+xml');
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
          
          // Extract and copy all defs first (important for animations, gradients, etc.)
          const defsElements = svgElement.getElementsByTagName('defs');
          let defs;
          
          // Check if root SVG already has a defs element, or create one
          const rootDefs = rootSvg.getElementsByTagName('defs');
          if (rootDefs.length > 0) {
            defs = rootDefs[0];
          } else {
            defs = rootSvg.createElement('defs');
            rootElement.appendChild(defs);
          }
          
          // Copy all defs content
          if (defsElements.length > 0) {
            for (let i = 0; i < defsElements.length; i++) {
              const defsElement = defsElements[i];
              for (let j = 0; j < defsElement.childNodes.length; j++) {
                defs.appendChild(defsElement.childNodes[j].cloneNode(true));
              }
            }
          }
          
          // Copy all style elements
          const styles = svgElement.getElementsByTagName('style');
          for (let i = 0; i < styles.length; i++) {
            const style = styles[i].cloneNode(true);
            // Add to defs instead of directly to group to prevent duplication
            defs.appendChild(style);
          }
          
          // Copy scripts if present (might be needed for complex animations)
          const scripts = svgElement.getElementsByTagName('script');
          for (let i = 0; i < scripts.length; i++) {
            const script = scripts[i].cloneNode(true);
            defs.appendChild(script);
          }
          
          // Copy all other elements except defs, style, and script which we've already handled
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            if (node.nodeName !== 'defs' && node.nodeName !== 'style' && node.nodeName !== 'script') {
              group.appendChild(node.cloneNode(true));
            }
          }
          
          // Copy necessary attributes from source SVG to group
          const attributesToCopy = ['class', 'style'];
          attributesToCopy.forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          });
          
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
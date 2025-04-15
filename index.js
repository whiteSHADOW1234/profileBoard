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
    
    // Create a style element to collect all CSS
    const styleElement = rootSvg.createElement('style');
    styleElement.setAttribute('type', 'text/css');
    rootElement.appendChild(styleElement);
    
    // A set to collect unique style content
    const styleSet = new Set();
    
    // Function to extract and process styles from an SVG element
    const extractStyles = (svgElement) => {
      const styleElements = svgElement.getElementsByTagName('style');
      for (let i = 0; i < styleElements.length; i++) {
        const style = styleElements[i];
        if (style.textContent) {
          // Add a unique prefix to CSS class and ID selectors to avoid conflicts
          const styleContent = style.textContent;
          const itemPrefix = `item-${Math.random().toString(36).substring(2, 8)}`;
          
          // Add the prefix to class and ID selectors
          let processedStyle = styleContent
            // Classes
            .replace(/\.([\w-]+)/g, `.${itemPrefix}-$1`)
            // IDs
            .replace(/#([\w-]+)/g, `#${itemPrefix}-$1`);
          
          styleSet.add(processedStyle);
          
          // Replace the original class and ID names in the SVG with prefixed ones
          const allElements = svgElement.getElementsByTagName('*');
          for (let j = 0; j < allElements.length; j++) {
            const el = allElements[j];
            
            if (el.hasAttribute('class')) {
              const classes = el.getAttribute('class').split(/\s+/);
              const prefixedClasses = classes.map(cls => `${itemPrefix}-${cls}`).join(' ');
              el.setAttribute('class', prefixedClasses);
            }
            
            if (el.hasAttribute('id')) {
              const id = el.getAttribute('id');
              el.setAttribute('id', `${itemPrefix}-${id}`);
            }
          }
        }
      }
    };
    
    // Function to prefix element IDs and classes
    const prefixIdReferences = (svgElement, prefix) => {
      const allElements = svgElement.getElementsByTagName('*');
      
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        const attributes = el.attributes;
        
        for (let j = 0; j < attributes.length; j++) {
          const attr = attributes[j];
          const name = attr.name;
          const value = attr.value;
          
          // Update URL references like url(#someId)
          if (value.includes('url(#')) {
            const newValue = value.replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`);
            el.setAttribute(name, newValue);
          }
          
          // Handle xlink:href references
          if (name === 'xlink:href' && value.startsWith('#')) {
            el.setAttribute(name, `#${prefix}-${value.substring(1)}`);
          }
        }
      }
    };
    
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
            // For non-SVG images, still use base64 encoding
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
            // For non-SVG images, still use base64 encoding
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
            // For non-SVG images, still use base64 encoding
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
          
          // Generate a unique ID prefix for this item
          const uniquePrefix = `svg-${item.id.replace(/[^a-zA-Z0-9]/g, '')}-${Math.random().toString(36).substring(2, 6)}`;
          
          // Extract and process CSS styles
          extractStyles(svgElement);
          
          // Update ID references in the SVG
          prefixIdReferences(svgElement, uniquePrefix);
          
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
          
          // Copy necessary attributes from source SVG
          const attributesToCopy = ['class', 'xmlns:xlink'];
          attributesToCopy.forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              group.setAttribute(attr, svgElement.getAttribute(attr));
            }
          });
          
          // Extract and copy all defs (important for animations, gradients, etc.)
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            // If we don't already have a defs element in the root, create one
            let rootDefs = rootSvg.getElementsByTagName('defs')[0];
            if (!rootDefs) {
              rootDefs = rootSvg.createElement('defs');
              rootElement.insertBefore(rootDefs, styleElement.nextSibling);
            }
            
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              // Copy each child of the defs element to the root defs
              for (let j = 0; j < defs.childNodes.length; j++) {
                rootDefs.appendChild(defs.childNodes[j].cloneNode(true));
              }
            }
          }
          
          // Copy all child nodes except <defs> and <style> to maintain structure and animations
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            const nodeName = node.nodeName.toLowerCase();
            if (nodeName !== 'defs' && nodeName !== 'style' && nodeName !== 'svg') {
              group.appendChild(node.cloneNode(true));
            }
          }
          
          rootElement.appendChild(group);
        } else if (item.type === 'image' || item.type.match(/^(png|jpg|jpeg|gif)$/)) {
          // Create image element using base64
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
    
    // Add all collected styles to the style element
    styleElement.textContent = Array.from(styleSet).join('\n');
    
    // Serialize the merged SVG
    const mergedSvgString = serializer.serializeToString(rootSvg);
    
    // Write merged SVG to temporary file
    await fs.writeFile('merged.svg', mergedSvgString);
    
    // Optimize SVG with SVGO but preserve animations and styles
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
              // Critical for CSS animations
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
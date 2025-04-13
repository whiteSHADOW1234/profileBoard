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
        let isSvg = item.type === 'svg';
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          // Check Content-Type header to detect SVG, regardless of the item.type
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.includes('svg')) {
            isSvg = true;
          }
          
          if (isSvg) {
            // Get SVG as text
            content = await response.text();
          } else {
            // For non-SVG images, get binary data
            const buffer = await response.arrayBuffer();
            const imageData = Buffer.from(buffer);
            
            // Create image element for non-SVG content
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            
            // Use base64 encoding for the image data
            const base64 = imageData.toString('base64');
            const mimeType = contentType || `image/${item.type}` || 'image/png';
            imageElement.setAttribute('href', `data:${mimeType};base64,${base64}`);
            
            rootElement.appendChild(imageElement);
            continue; // Skip the SVG processing below
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
          
          if (isSvg) {
            content = fileContent.toString('utf8');
          } else {
            // For non-SVG images, create an image element
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            
            // Use base64 encoding for the image data
            const base64 = fileContent.toString('base64');
            const mimeType = `image/${item.type}` || 'image/png';
            imageElement.setAttribute('href', `data:${mimeType};base64,${base64}`);
            
            rootElement.appendChild(imageElement);
            continue; // Skip the SVG processing below
          }
        } else if (item.url.startsWith('images/')) {
          // Direct path to images directory
          const imagePath = item.url;
          
          core.info(`Reading local file: ${imagePath}`);
          
          if (!assetMap.has(imagePath)) {
            throw new Error(`Local asset not found: ${imagePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(imagePath));
          
          if (isSvg) {
            content = fileContent.toString('utf8');
          } else {
            // For non-SVG images, create an image element
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            
            // Use base64 encoding for the image data
            const base64 = fileContent.toString('base64');
            const mimeType = `image/${item.type}` || 'image/png';
            imageElement.setAttribute('href', `data:${mimeType};base64,${base64}`);
            
            rootElement.appendChild(imageElement);
            continue; // Skip the SVG processing below
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process SVG content
        if (isSvg) {
          // Try to detect if the content is already an SVG
          if (!content.trim().startsWith('<svg') && !content.trim().startsWith('<?xml')) {
            core.warning(`Content from ${item.url} doesn't appear to be SVG. Treating as image instead.`);
            
            // Create an image element as fallback
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            imageElement.setAttribute('href', item.url);
            
            rootElement.appendChild(imageElement);
            continue;
          }
          
          // Parse SVG content
          const svgDoc = parser.parseFromString(content, 'image/svg+xml');
          
          // Check for parsing errors
          const errors = svgDoc.getElementsByTagName('parsererror');
          if (errors.length > 0) {
            throw new Error(`Failed to parse SVG from ${item.url}`);
          }
          
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
          
          // Extract critical attributes from the SVG to preserve animations and styling
          const svgAttributesToPreserve = [
            'version', 'baseProfile', 'xmlns', 'xmlns:xlink', 
            'xmlns:svg', 'xmlns:dc', 'xmlns:cc', 'xmlns:rdf', 
            'xmlns:sodipodi', 'xmlns:inkscape', 'style', 'class'
          ];
          
          // Copy key namespace definitions and attributes to ensure animations and styling work
          svgAttributesToPreserve.forEach(attr => {
            if (svgElement.hasAttribute(attr)) {
              // Don't copy xmlns attributes to the group, they're already on the root
              if (!attr.startsWith('xmlns')) {
                group.setAttribute(attr, svgElement.getAttribute(attr));
              }
            }
          });
          
          // Extract all defs and add them to the root SVG (for animations, gradients, filters, etc.)
          const defsElements = svgElement.getElementsByTagName('defs');
          if (defsElements.length > 0) {
            for (let i = 0; i < defsElements.length; i++) {
              const defs = defsElements[i];
              
              // Check if the root SVG already has a defs element
              let rootDefs = rootElement.getElementsByTagName('defs')[0];
              
              if (!rootDefs) {
                // Create a defs element if it doesn't exist
                rootDefs = rootSvg.createElement('defs');
                rootElement.insertBefore(rootDefs, rootElement.firstChild);
              }
              
              // Copy each child from the defs to the root defs
              for (let j = 0; j < defs.childNodes.length; j++) {
                const defChild = defs.childNodes[j];
                rootDefs.appendChild(defChild.cloneNode(true));
              }
            }
          }
          
          // Copy all styles from the SVG
          const styleElements = svgElement.getElementsByTagName('style');
          if (styleElements.length > 0) {
            // Find or create a style element in the root
            let rootStyle = rootElement.getElementsByTagName('style')[0];
            if (!rootStyle) {
              rootStyle = rootSvg.createElement('style');
              rootElement.insertBefore(rootStyle, rootElement.firstChild);
            }
            
            // Append all style content
            for (let i = 0; i < styleElements.length; i++) {
              const styleContent = styleElements[i].textContent || '';
              if (styleContent.trim()) {
                const textNode = rootSvg.createTextNode(styleContent);
                rootStyle.appendChild(textNode);
              }
            }
          }
          
          // Copy all other elements (excluding <svg>, <defs>, and <style>)
          for (let i = 0; i < svgElement.childNodes.length; i++) {
            const node = svgElement.childNodes[i];
            const nodeName = node.nodeName.toLowerCase();
            
            if (nodeName !== 'defs' && nodeName !== 'style' && nodeName !== '#comment') {
              group.appendChild(node.cloneNode(true));
            }
          }
          
          rootElement.appendChild(group);
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
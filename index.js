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
    
    // Define background coordinates
    const bgMinX = -150;
    const bgMaxX = 1050;
    const bgMinY = 0;
    const bgMaxY = 600;
    
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
    
    // Calculate SVG dimensions
    const svgWidth = bgMaxX - bgMinX;
    const svgHeight = bgMaxY - bgMinY;
    
    // Create the root SVG with calculated dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${bgMinX} ${bgMinY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Process each layout item
    for (const item of layout) {
      try {
        core.info(`Processing item: ${item.id}`);
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          const contentType = response.headers.get('content-type');
          core.info(`Content-Type: ${contentType}`);
          
          if (item.type === 'svg') {
            // Get the raw SVG text
            const svgText = await response.text();
            
            // Parse the SVG content
            try {
              // Create a group to contain the SVG content
              const group = rootSvg.createElement('g');
              group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
              
              // Parse the SVG content
              const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
              const svgElement = svgDoc.documentElement;
              
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
              
              // Apply scaling if necessary
              if (svgWidth !== item.width || svgHeight !== item.height) {
                const scaleX = item.width / svgWidth;
                const scaleY = item.height / svgHeight;
                group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
              }
              
              // Copy important namespace attributes from source SVG to root SVG
              // This ensures animations and other features work correctly
              const namespacesToCopy = ['xmlns', 'xmlns:xlink', 'xmlns:svg'];
              namespacesToCopy.forEach(ns => {
                if (svgElement.hasAttribute(ns) && !rootElement.hasAttribute(ns)) {
                  rootElement.setAttribute(ns, svgElement.getAttribute(ns));
                }
              });
              
              // Copy all defs to the root SVG element to ensure animations work
              const defsElements = svgElement.getElementsByTagName('defs');
              if (defsElements.length > 0) {
                // Check if root SVG already has a defs element
                let rootDefs = rootElement.getElementsByTagName('defs')[0];
                if (!rootDefs) {
                  rootDefs = rootSvg.createElement('defs');
                  rootElement.appendChild(rootDefs);
                }
                
                // Copy all defs content
                for (let i = 0; i < defsElements.length; i++) {
                  const defs = defsElements[i];
                  // Copy all children of defs
                  for (let j = 0; j < defs.childNodes.length; j++) {
                    rootDefs.appendChild(defs.childNodes[j].cloneNode(true));
                  }
                }
              }
              
              // Copy all style elements to preserve CSS animations
              const styleElements = svgElement.getElementsByTagName('style');
              if (styleElements.length > 0) {
                for (let i = 0; i < styleElements.length; i++) {
                  rootElement.appendChild(styleElements[i].cloneNode(true));
                }
              }
              
              // Copy all child nodes except defs and style (already handled)
              for (let i = 0; i < svgElement.childNodes.length; i++) {
                const node = svgElement.childNodes[i];
                const nodeName = node.nodeName.toLowerCase();
                if (nodeName !== 'defs' && nodeName !== 'style') {
                  group.appendChild(node.cloneNode(true));
                }
              }
              
              rootElement.appendChild(group);
              core.info(`Successfully inlined SVG for item: ${item.id}`);
              
            } catch (svgParseError) {
              core.warning(`Error parsing SVG for item ${item.id}: ${svgParseError.message}`);
              // Fallback to image embedding if SVG parsing fails
              const imageElement = rootSvg.createElement('image');
              imageElement.setAttribute('x', item.x);
              imageElement.setAttribute('y', item.y);
              imageElement.setAttribute('width', item.width);
              imageElement.setAttribute('height', item.height);
              imageElement.setAttribute('href', item.url);
              rootElement.appendChild(imageElement);
            }
            
          } else {
            // Handle as image
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            imageElement.setAttribute('href', item.url);
            rootElement.appendChild(imageElement);
          }
          
        } else if (item.url.startsWith('blob:') || item.url.startsWith('images/')) {
          // Local file handling
          const filePath = item.url.startsWith('blob:') 
            ? path.join('images', item.url.substring(5)) // Remove 'blob:' prefix and prepend 'images/'
            : item.url; // Already contains 'images/' prefix
          
          core.info(`Reading local file: ${filePath}`);
          
          if (!assetMap.has(filePath)) {
            throw new Error(`Local asset not found: ${filePath}`);
          }
          
          const fileContent = await fs.readFile(assetMap.get(filePath));
          
          if (item.type === 'svg') {
            // Parse local SVG file
            const svgText = fileContent.toString('utf8');
            try {
              // Create a group to contain the SVG content
              const group = rootSvg.createElement('g');
              group.setAttribute('transform', `translate(${item.x}, ${item.y})`);
              
              // Parse the SVG content
              const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
              const svgElement = svgDoc.documentElement;
              
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
              
              // Apply scaling if necessary
              if (svgWidth !== item.width || svgHeight !== item.height) {
                const scaleX = item.width / svgWidth;
                const scaleY = item.height / svgHeight;
                group.setAttribute('transform', `translate(${item.x}, ${item.y}) scale(${scaleX}, ${scaleY})`);
              }
              
              // Copy all defs to the root SVG element
              const defsElements = svgElement.getElementsByTagName('defs');
              if (defsElements.length > 0) {
                // Check if root SVG already has a defs element
                let rootDefs = rootElement.getElementsByTagName('defs')[0];
                if (!rootDefs) {
                  rootDefs = rootSvg.createElement('defs');
                  rootElement.appendChild(rootDefs);
                }
                
                // Copy all defs content
                for (let i = 0; i < defsElements.length; i++) {
                  const defs = defsElements[i];
                  // Copy all children of defs
                  for (let j = 0; j < defs.childNodes.length; j++) {
                    rootDefs.appendChild(defs.childNodes[j].cloneNode(true));
                  }
                }
              }
              
              // Copy all style elements
              const styleElements = svgElement.getElementsByTagName('style');
              if (styleElements.length > 0) {
                for (let i = 0; i < styleElements.length; i++) {
                  rootElement.appendChild(styleElements[i].cloneNode(true));
                }
              }
              
              // Copy all child nodes except defs and style (already handled)
              for (let i = 0; i < svgElement.childNodes.length; i++) {
                const node = svgElement.childNodes[i];
                const nodeName = node.nodeName.toLowerCase();
                if (nodeName !== 'defs' && nodeName !== 'style') {
                  group.appendChild(node.cloneNode(true));
                }
              }
              
              rootElement.appendChild(group);
              
            } catch (svgParseError) {
              core.warning(`Error parsing local SVG for item ${item.id}: ${svgParseError.message}`);
              // Fallback to embedding as image
              const imageElement = rootSvg.createElement('image');
              imageElement.setAttribute('x', item.x);
              imageElement.setAttribute('y', item.y);
              imageElement.setAttribute('width', item.width);
              imageElement.setAttribute('height', item.height);
              
              // Convert to data URL
              const base64 = fileContent.toString('base64');
              imageElement.setAttribute('href', `data:image/svg+xml;base64,${base64}`);
              
              rootElement.appendChild(imageElement);
            }
          } else {
            // Handle as image
            const imageElement = rootSvg.createElement('image');
            imageElement.setAttribute('x', item.x);
            imageElement.setAttribute('y', item.y);
            imageElement.setAttribute('width', item.width);
            imageElement.setAttribute('height', item.height);
            
            // Convert to data URL
            const base64 = fileContent.toString('base64');
            const mimeType = item.type === 'image' ? 'image/png' : `image/${item.type}`;
            imageElement.setAttribute('href', `data:${mimeType};base64,${base64}`);
            
            rootElement.appendChild(imageElement);
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
      } catch (error) {
        core.warning(`Error processing item ${JSON.stringify(item)}: ${error.message}`);
      }
    }
    
    // Ensure all IDs are unique to avoid conflicts between inlined SVGs
    // This is important for animations that reference IDs
    const idMap = new Map();
    const elementsWithId = rootElement.querySelectorAll('[id]');
    
    for (let i = 0; i < elementsWithId.length; i++) {
      const element = elementsWithId[i];
      const originalId = element.getAttribute('id');
      
      if (idMap.has(originalId)) {
        // ID already exists, create a new unique ID
        const newId = `${originalId}-${i}`;
        element.setAttribute('id', newId);
        
        // Update references to this ID in the document
        const idRef = `#${originalId}`;
        const newIdRef = `#${newId}`;
        
        // Update href attributes
        const hrefElements = rootElement.querySelectorAll(`[href="${idRef}"]`);
        for (let j = 0; j < hrefElements.length; j++) {
          hrefElements[j].setAttribute('href', newIdRef);
        }
        
        // Update fill references
        const fillElements = rootElement.querySelectorAll(`[fill="url(${idRef})"]`);
        for (let j = 0; j < fillElements.length; j++) {
          fillElements[j].setAttribute('fill', `url(${newIdRef})`);
        }
        
        // Update stroke references
        const strokeElements = rootElement.querySelectorAll(`[stroke="url(${idRef})"]`);
        for (let j = 0; j < strokeElements.length; j++) {
          strokeElements[j].setAttribute('stroke', `url(${newIdRef})`);
        }
        
        // Update mask references
        const maskElements = rootElement.querySelectorAll(`[mask="url(${idRef})"]`);
        for (let j = 0; j < maskElements.length; j++) {
          maskElements[j].setAttribute('mask', `url(${newIdRef})`);
        }
        
        // Update clip-path references
        const clipPathElements = rootElement.querySelectorAll(`[clip-path="url(${idRef})"]`);
        for (let j = 0; j < clipPathElements.length; j++) {
          clipPathElements[j].setAttribute('clip-path', `url(${newIdRef})`);
        }
        
        // Update animation references
        const animationElements = rootElement.querySelectorAll(`[begin*="${originalId}"]`);
        for (let j = 0; j < animationElements.length; j++) {
          const beginValue = animationElements[j].getAttribute('begin');
          animationElements[j].setAttribute('begin', beginValue.replace(originalId, newId));
        }
      } else {
        idMap.set(originalId, true);
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
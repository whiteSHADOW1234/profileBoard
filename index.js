import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as glob from '@actions/glob';
import * as github from '@actions/github';
import { promises as fs } from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { optimize } from 'svgo';
import { DOMParser, XMLSerializer } from 'xmldom';

/**
 * Main function to run the GitHub Action
 */
async function run() {
  try {
    // Get inputs from action
    const layoutInput = core.getInput('layout', { required: true });
    const assetsInput = core.getInput('assets', { required: false }) || 'images/*.svg';
    const token = core.getInput('token', { required: true });
    
    core.info('Parsing layout JSON...');
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
    core.info('Scanning local assets...');
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
    
    // Define the SVG canvas size based on specified dimensions
    const minX = -150;
    const maxX = 1050;
    const minY = 0;
    const maxY = 600;
    
    const svgWidth = maxX - minX;
    const svgHeight = maxY - minY;
    
    core.info(`Creating root SVG with dimensions: width=${svgWidth}, height=${svgHeight}, viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"`);
    
    // Create the root SVG with specified dimensions
    const rootSvg = parser.parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${svgWidth}" height="${svgHeight}" viewBox="${minX} ${minY} ${svgWidth} ${svgHeight}"></svg>`,
      'image/svg+xml'
    );
    
    const rootElement = rootSvg.documentElement;
    
    // Add background element
    const bgRect = rootSvg.createElement('rect');
    bgRect.setAttribute('x', minX.toString());
    bgRect.setAttribute('y', minY.toString());
    bgRect.setAttribute('width', svgWidth.toString());
    bgRect.setAttribute('height', svgHeight.toString());
    bgRect.setAttribute('fill', 'transparent');
    rootElement.appendChild(bgRect);
    
    // Function to extract SVG content from element
    function extractSvgContent(svgElement) {
      // Convert SVG element to string
      return serializer.serializeToString(svgElement);
    }
    
    // Process each layout item
    for (const item of layout) {
      try {
        core.info(`Processing item: ${item.id} (${item.type}) at position x=${item.x}, y=${item.y}`);
        let content;
        let contentType;
        
        // Handle different URL types
        if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
          // Remote URL - fetch content
          core.info(`Fetching remote URL: ${item.url}`);
          const response = await fetch(item.url);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch ${item.url}: ${response.statusText}`);
          }
          
          contentType = response.headers.get('content-type');
          
          if (item.type === 'svg' || contentType?.includes('svg')) {
            // Get the raw SVG text
            content = await response.text();
          } else {
            // For images, get binary data and convert to base64 data URL
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
            content = fileContent.toString('utf8');
          } else {
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const ext = path.extname(imagePath).slice(1) || item.type;
            const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
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
            // For images, convert to base64
            const base64 = fileContent.toString('base64');
            const ext = path.extname(imagePath).slice(1) || item.type;
            const mimeType = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
            content = `data:${mimeType};base64,${base64}`;
          }
        } else {
          throw new Error(`Unsupported URL format: ${item.url}`);
        }
        
        // Process content based on type
        if (item.type === 'svg' || contentType?.includes('svg')) {
          // Parse SVG content
          try {
            const svgDoc = parser.parseFromString(content, 'image/svg+xml');
            
            // Check for parsing errors
            const errors = svgDoc.getElementsByTagName('parsererror');
            if (errors.length > 0) {
              throw new Error(`Failed to parse SVG: ${extractSvgContent(errors[0])}`);
            }
            
            const svgElement = svgDoc.documentElement;
            
            // Create a group to position the SVG
            const group = rootSvg.createElement('g');
            group.setAttribute('id', `item-${item.id}`);
            
            // Get SVG dimensions from different possible attributes
            let svgWidth, svgHeight;
            
            if (svgElement.hasAttribute('width') && svgElement.hasAttribute('height')) {
              svgWidth = parseFloat(svgElement.getAttribute('width'));
              svgHeight = parseFloat(svgElement.getAttribute('height'));
            } else if (svgElement.hasAttribute('viewBox')) {
              const viewBox = svgElement.getAttribute('viewBox').split(/[\s,]+/);
              if (viewBox.length >= 4) {
                svgWidth = parseFloat(viewBox[2]);
                svgHeight = parseFloat(viewBox[3]);
              }
            }
            
            // Set default dimensions if not found
            if (!svgWidth || !svgHeight) {
              svgWidth = item.width;
              svgHeight = item.height;
            }
            
            // Apply transformation for positioning and scaling
            let transform = `translate(${item.x}, ${item.y})`;
            
            // Apply scaling if dimensions don't match
            if (svgWidth !== item.width || svgHeight !== item.height) {
              const scaleX = item.width / svgWidth;
              const scaleY = item.height / svgHeight;
              transform += ` scale(${scaleX}, ${scaleY})`;
            }
            
            group.setAttribute('transform', transform);
            
            // Preserve namespace declarations that might be needed for animations/styling
            for (let i = 0; i < svgElement.attributes.length; i++) {
              const attr = svgElement.attributes[i];
              if (attr.name.startsWith('xmlns:') && !group.hasAttribute(attr.name)) {
                group.setAttribute(attr.name, attr.value);
              }
            }
            
            // Preserve defs (important for animations, filters, etc.)
            const defsElements = svgElement.getElementsByTagName('defs');
            const defsGroup = rootSvg.createElement('defs');
            group.appendChild(defsGroup);
            
            if (defsElements.length > 0) {
              for (let i = 0; i < defsElements.length; i++) {
                const defs = defsElements[i];
                for (let j = 0; j < defs.childNodes.length; j++) {
                  defsGroup.appendChild(defs.childNodes[j].cloneNode(true));
                }
              }
            }
            
            // Copy all child nodes except defs to preserve structure
            for (let i = 0; i < svgElement.childNodes.length; i++) {
              const node = svgElement.childNodes[i];
              if (node.nodeName.toLowerCase() !== 'defs') {
                group.appendChild(node.cloneNode(true));
              }
            }
            
            rootElement.appendChild(group);
            core.info(`Successfully processed SVG item: ${item.id}`);
          } catch (svgError) {
            core.warning(`Error processing SVG content for item ${item.id}: ${svgError.message}`);
            // Fallback to <foreignObject> embedding for problematic SVGs
            core.info(`Falling back to foreignObject embedding for item ${item.id}`);
            
            const foreignObject = rootSvg.createElement('foreignObject');
            foreignObject.setAttribute('x', item.x.toString());
            foreignObject.setAttribute('y', item.y.toString());
            foreignObject.setAttribute('width', item.width.toString());
            foreignObject.setAttribute('height', item.height.toString());
            
            // Sanitize content to prevent XML issues
            content = content.replace(/<\?xml.*?\?>/, '');
            
            // Create a div wrapper with the raw SVG content
            const div = rootSvg.createElement('div');
            div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
            div.setAttribute('style', 'width:100%;height:100%');
            
            // Set the innerHTML (using a hack since xmldom doesn't support innerHTML)
            const placeholder = '___SVG_CONTENT_PLACEHOLDER___';
            div.textContent = placeholder;
            
            // Serialize, replace placeholder with actual content, then parse again
            let serialized = serializer.serializeToString(div);
            serialized = serialized.replace(placeholder, content);
            
            const tempDoc = parser.parseFromString(
              `<root>${serialized}</root>`, 'text/xml'
            );
            
            foreignObject.appendChild(tempDoc.documentElement.firstChild);
            rootElement.appendChild(foreignObject);
          }
        } else if (item.type === 'image' || ['png', 'jpg', 'jpeg', 'gif'].includes(item.type)) {
          // Create image element
          const imageElement = rootSvg.createElement('image');
          imageElement.setAttribute('id', `item-${item.id}`);
          imageElement.setAttribute('x', item.x.toString());
          imageElement.setAttribute('y', item.y.toString());
          imageElement.setAttribute('width', item.width.toString());
          imageElement.setAttribute('height', item.height.toString());
          imageElement.setAttribute('href', content); // Using href attribute which works in modern browsers
          
          rootElement.appendChild(imageElement);
          core.info(`Successfully processed image item: ${item.id}`);
        }
      } catch (error) {
        core.warning(`Error processing item ${item.id}: ${error.message}`);
      }
    }
    
    // Serialize the merged SVG
    core.info('Serializing merged SVG...');
    const mergedSvgString = serializer.serializeToString(rootSvg);
    
    // Write merged SVG to temporary file
    await fs.writeFile('merged.svg', mergedSvgString);
    
    // Optimize SVG but preserve animations and interactivity
    core.info('Optimizing SVG with SVGO...');
    try {
      const optimizedSvg = optimize(mergedSvgString, {
        multipass: true,
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
                // Critical for animations and interactivity
                inlineStyles: false,
                minifyStyles: false,
                cleanupIDs: false,
                removeXMLProcInst: false
              },
            },
          },
          {
            name: 'removeDoctype',
            active: true
          },
          {
            name: 'removeXMLNS',
            active: false
          }
        ],
      });
      
      // Write optimized SVG to README.svg
      await fs.writeFile('README.svg', optimizedSvg.data);
      core.info('SVG optimization completed successfully.');
    } catch (svgoError) {
      core.warning(`SVGO optimization failed: ${svgoError.message}. Using unoptimized SVG.`);
      // If optimization fails, use the original merged SVG
      await fs.writeFile('README.svg', mergedSvgString);
    }
    
    // Configure git user for commit
    core.info('Configuring Git user...');
    await exec.exec('git', ['config', 'user.name', 'GitHub Action']);
    await exec.exec('git', ['config', 'user.email', 'action@github.com']);
    
    // Check if there are changes to commit
    core.info('Checking for changes to commit...');
    const { exitCode } = await exec.exec('git', ['diff', '--quiet', 'README.svg'], { ignoreReturnCode: true });
    
    if (exitCode !== 0) {
      // Changes detected, commit and push
      core.info('Changes detected, committing and pushing...');
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
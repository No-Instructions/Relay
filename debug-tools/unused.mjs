import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, "..", 'src'); // Adjust this to your project's source directory
const fileExtensions = ['.ts', '.tsx', '.svelte']; // Including .svelte files

async function getAllFiles(dir) {
    let files = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files = files.concat(await getAllFiles(fullPath));
        } else if (fileExtensions.includes(path.extname(entry.name))) {
            files.push(fullPath);
        }
    }
    return files;
}

function resolveImportPath(importPath, currentFile, allFiles) {
    const currentDir = path.dirname(currentFile);
    let resolvedPath = path.resolve(currentDir, importPath);
    
    // If the resolved path doesn't have an extension, try adding extensions
    if (!path.extname(resolvedPath)) {
        for (const ext of fileExtensions) {
            const pathWithExt = resolvedPath + ext;
            if (allFiles.includes(pathWithExt)) {
                return pathWithExt;
            }
        }
        // If no exact match, check if it's a directory with an index file
        for (const ext of fileExtensions) {
            const indexPath = path.join(resolvedPath, `index${ext}`);
            if (allFiles.includes(indexPath)) {
                return indexPath;
            }
        }
    }
    
    return resolvedPath;
}

async function findReferences(filePath, allFiles) {
    const content = await fs.readFile(filePath, 'utf-8');
    const references = new Set();

    // Regex to match import statements
    const importRegex = /import\s+(?:(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+)?['"]([^'"]+)['"]/g;
    
    let match;
    while ((match = importRegex.exec(content)) !== null) {
        const importPath = match[1];
        const resolvedPath = resolveImportPath(importPath, filePath, allFiles);
        if (allFiles.includes(resolvedPath)) {
            references.add(resolvedPath);
        }
    }

    // Check for Svelte component usage
    allFiles.forEach(file => {
        const fileName = path.basename(file, path.extname(file));
        if (content.includes(`<${fileName}`)) {
            references.add(file);
        }
    });

    return Array.from(references);
}

async function analyzeFiles() {
    const allFiles = await getAllFiles(projectRoot);
    const referenceMap = new Map();

    for (const file of allFiles) {
        const references = await findReferences(file, allFiles);
        referenceMap.set(file, references);
    }

    return { allFiles, referenceMap };
}

try {
    const { allFiles, referenceMap } = await analyzeFiles();
    console.log('File analysis:');
    allFiles.forEach(file => {
        const relativePath = path.relative(projectRoot, file);
        const references = referenceMap.get(file);
        const isReferenced = Array.from(referenceMap.values()).some(refs => refs.includes(file));
        const isImported = references.length > 0 || isReferenced;

        console.log(`[${isImported ? 'IMPORTED' : 'NOT IMPORTED'}] ${relativePath}`);
        if (references.length > 0) {
            console.log('  References:');
            references.forEach(ref => console.log(`    - ${path.relative(projectRoot, ref)}`));
        }
        if (isReferenced) {
            console.log('  Referenced in:');
            allFiles.forEach(f => {
                if (referenceMap.get(f).includes(file)) {
                    console.log(`    - ${path.relative(projectRoot, f)}`);
                }
            });
        }
        console.log(''); // Empty line for readability
    });
} catch (error) {
    console.error('An error occurred:', error);
}

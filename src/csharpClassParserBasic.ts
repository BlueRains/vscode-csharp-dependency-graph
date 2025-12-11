import * as fs from "node:fs";
import * as util from "node:util";

const readFile = util.promisify(fs.readFile);

interface Type extends DependencyInfo {
  subTypes: Type[];
}

interface Callable {
  parameters: Type[];
}

interface Function extends Callable {
  parameters: Type[];
  returnType?: Type;
}
interface Constructor extends Callable {
  name: string;
}

interface ClassBody {
  functions: Function[];
  constructors: Constructor[];
  lines: Type[];
  staticCalls: Type[];
  variables: Type[];
}

interface Class extends ClassBody {
  className: string;
  inheritances?: Type[];
}
interface BaseFile {
  classes: Class[];
  namespace: string;
  imports: string[];
}
interface ClassInfo {
  namespace:string;
  projectName:string;
}
interface File extends BaseFile {
  projectName: string;
}

export interface ClassDependency {
  className: string;
  projectName: string;
  namespace: string;
  dependencies: DependencyInfo[];
  filePath: string;
}

export interface DependencyInfo {
  className: string;
  namespace: string;
  projectName: string;
}

export const BRACKETS = Object.freeze({
  ANGLE: 1,
  ROUND: 2,
  BOX: 4,
  CURLY: 8,
  STRING: 16,
  CHAR: 32,
  ALL: 63,
});
type ClassMapping = Map<string, ClassInfo>;
export const REGEX = Object.freeze({
  class: /\bclass\s+\w{1,60}/,
  namespace: /namespace\s+([\w.]+)/,
  newDeclaration: /new\s+([\w.<>,]+?)\s*[({}]/g, //TODO: This doesnt catch e.g. MyClass item = new();
  classProperty: /^\s*(?:\w+\s+){0,3}([\w<>[\],.]+)\s+\w+\s*\{/,
  classField: /^\s*(?:\w+\s+){0,3}([\w<>[\],.?]+)\s+\w+\s*[=;]/,
  classMethod:
    /\b(?:public|private|protected|internal)\s+(?:\w+\s+){0,2}([\w<>[\],.]+)\s+(\w+)\s*\(([^)]*)\)/,
  classConstructor:
    /\b(?:public|private|protected|internal)\s+(\w+)\s*\(([^)]*)\)/,
  staticMethodCall: /\b([A-Z][\w.]*)\.\w+\(/g,
});

function bracketsToIncludes(
  current: number[],
  brackets: number,
  char: string
): boolean {
  let i = 0;
  if (brackets & BRACKETS.ANGLE && char === "<") {
    current[i]++;
  }
  if (brackets & BRACKETS.ANGLE && char === ">") {
    current[i]--;
  }
  i++;
  if (brackets & BRACKETS.ROUND && char === "(") {
    current[i]++;
  }
  if (brackets & BRACKETS.ROUND && char === ")") {
    current[i]--;
  }
  i++;
  if (brackets & BRACKETS.BOX && char === "[") {
    current[i]++;
  }
  if (brackets & BRACKETS.BOX && char === "]") {
    current[i]--;
  }
  i++;
  if (brackets & BRACKETS.CURLY && char === "{") {
    current[i]++;
  }
  if (brackets & BRACKETS.CURLY && char === "}") {
    current[i]--;
  }
  i++;
  if (brackets & BRACKETS.STRING && char === '"') {
    current[i] = Math.abs(current[i] - 1);
  }
  i++;
  if (brackets & BRACKETS.CHAR && char === `'`) {
    current[i] = Math.abs(current[i] - 1);
  }
  return current.reduce((a, b) => a + b) === 0;
}
/**
 * If both code and a comment is in the same line, remove the comment
 * @param line The line to strip
 * @returns
 */
function stripRightComment(line: string): string {
  if (line.indexOf("//") === -1) {
    return line;
  }
  let index = 0;
  while (index > -1 && index < line.length - 1) {
    let index = findNext(line, "/", BRACKETS.STRING | BRACKETS.CHAR);
    if (index !== -1 && line[index + 1] === "/") {
      return line.substring(0, index);
    }
  }
  // The comment we found was inside a string of some sort
  return line;
}
/**
 * Ensure all method calls and other such things are on a single line, so that parsing line by line doesn't fuck things up.
 * @param str The content to parse
 */
function preParseText(str: string): string {
  //First split in lines. Remove all that are only a comment
  // Then remove the parts that are partially comments
  let noComments = str
    .split("\n")
    .filter(
      (line) => !(line.trim().startsWith("//") || line.trim().startsWith("#"))
    );
  noComments.forEach((line, i, arr) => (arr[i] = stripRightComment(line)));
  let content = noComments.join("").replaceAll(/\/\*.*\*\//, ""); // Remove all multiline comments
  return content
    .replaceAll(";", ";\n")
    .replaceAll("{", "{\n")
    .replaceAll("}", "}\n");
}

/**
 * Analyzes C# source files to extract classes and their dependencies
 * @param projectSourceFiles Map of projects and their source files
 * @param includeClassDependencies Whether to include class-level dependencies
 */
export async function parseClassDependencies(
  projectSourceFiles: Map<string, string[]>,
  complete = true,
  includeClassDependencies = true
): Promise<ClassDependency[]> {
  // Return empty array if class dependencies should not be included
  if (!includeClassDependencies) {
    return [];
  }
  console.log("Complete classes:", complete);
  const classDependencies: ClassDependency[] = [];

  // First pass: collect all class names with their namespaces for cross-reference resolution
  const classRegistry:ClassMapping = new Map<
    string,
    { namespace: string; projectName: string }
  >();

  for (const [projectName, sourceFiles] of projectSourceFiles.entries()) {
    for (const filePath of sourceFiles) {
      try {
        const content = await readFile(filePath, "utf8");
        // Register classes with their namespaces
        registerClassesFromFile(content, projectName, classRegistry);
      } catch (error) {
        console.error(`Error registering classes from ${filePath}:`, error);
      }
    }
  }

  // Second pass: extract dependencies with proper namespace resolution
  for (const [projectName, sourceFiles] of projectSourceFiles.entries()) {
    for (const filePath of sourceFiles) {
      try {
        const content = await readFile(filePath, "utf8");
        const rawFile = extractClassesFromFile(content);
        const fileClasses: File = {
          classes: rawFile.classes,
          imports: rawFile.imports,
          namespace: rawFile.namespace,
          projectName: projectName,
        };

        classDependencies.push(...resolveClassDependencies(filePath, fileClasses, classRegistry));
      } catch (error) {
        console.error(`Error analyzing file ${filePath}:`, error);
      }
    }
  }

  return classDependencies;
}

function resolveClassDependencies(
  filePath:string,
  file: File,
  classRegistry: ClassMapping
): ClassDependency[] {
  // Resolve and filter dependencies
  let total: ClassDependency[] = [];
  file.classes.forEach((c) => {
    total.push({
      className: c.className,
      filePath,
      namespace:file.namespace,
      projectName: file.projectName,
      dependencies: resolveDependencies(
        total,
        file.imports,
        file.namespace,
        c.className,
        classRegistry,
        file,
        c
      )
  });
  });
  return total;
}

/**
 * A new approach -
 * with a first pass, we extract all the information out of the file
 * Then with a second pass, we store all the types
 * And with the third we show all the types
 */

/**
 * Registers classes with their namespaces for cross-reference resolution
 */
function registerClassesFromFile(
  content: string,
  projectName: string,
  classRegistry: ClassMapping
): void {
  // Find the namespace
  const namespaceRegex = /namespace\s+([\w.]+)/;
  const namespaceMatch = namespaceRegex.exec(content);
  const namespace = namespaceMatch ? namespaceMatch[1] : "";

  // Find classes - Limit the class name length to avoid excessive backtracking
  const MAX_CLASS_NAME_LENGTH = 60;
  const classRegex = new RegExp(
    `\\bclass\\s+(\\w{1,${MAX_CLASS_NAME_LENGTH}})`,
    "g"
  );
  let match;

  while ((match = classRegex.exec(content)) !== null) {
    const className = match[1];
    classRegistry.set(className, { namespace, projectName });

    // Also register with fully qualified name
    if (namespace) {
      classRegistry.set(`${namespace}.${className}`, {
        namespace,
        projectName,
      });
    }
  }
}

/**
 *
 * @param content full file content
 * @returns raw classes - only lines and indice
 */
function splitFileIntoClasses(content: string): string[][] {
  let classIndices: number[] = [];
  const allLines = content.split("\n");
  allLines.forEach((v, i, _) =>
    REGEX.class.test(v) ? classIndices.push(i) : null
  );

  const result = [];

  // Add full length for easy subsets of actual class content
  classIndices.push(allLines.length);
  let index = -1;
  //If there's 1 class, there'll be 2 classIndices. Therefore it only triggers at index = 0
  while (++index < classIndices.length - 1) {
    const subClassLines = allLines.slice(
      classIndices[index],
      classIndices[index + 1]
    );
    result.push(subClassLines);
  }
  return result;
}

/**
 * #TODO: Also extract interfaces or structs
 * Extracts class information from a C# file
 *
 * @param content
 * @param filePath
 * @param projectName
 * @param classRegistry
 * @returns
 */
function extractClassesFromFile(content: string): BaseFile {
  const classes: Class[] = [];
  const cleanedContent = preParseText(content);

  // Find the namespace
  const namespaceRegex = REGEX.namespace;
  const namespaceMatch = namespaceRegex.exec(cleanedContent);
  const namespace = namespaceMatch ? namespaceMatch[1] : "";

  // Extract using directives for namespace resolution
  const imports = extractImports(cleanedContent);

  // Find classes
  splitFileIntoClasses(cleanedContent).forEach((rawClass) => {
    const classDep = processSingleClass(rawClass);
    if (classDep) {
      classes.push(classDep);
    }
  });
  return {
    classes: classes,
    namespace: namespace,
    imports: imports,
  };
}

function processSingleClass(content: string[]): Class | null {
  let line = content[0];
  // Extract the class name - Limit the class name length
  const classNameRegex = REGEX.class;
  const classNameMatch = classNameRegex.exec(line);
  if (!classNameMatch) {
    return null;
  }

  const className = classNameMatch[1];

  //Extract inline constructor
  let constructor = extractInlineConstructor(line);

  // Extract the class body
  //TODO: Check if this is even needed
  // const classContent = getClassBody(content.join("\n"), 0);
  // const classContent = getClassBody(content.join("\n"), 0);
  // if (!classContent) {
  //   return null;
  // }

  // Extract dependencies from class content
  let {
    functions,
    constructors,
    lines,
    staticCalls: statics,
    variables,
  } = extractDependenciesFromClassContent(className, content);
  if (constructor) {
    constructors.push(constructor);
  }

  return {
    className,
    lines,
    functions,
    staticCalls: statics,
    constructors,
    variables,
    inheritances: extractInheritanceDependencies(line),
  };
}

/**
 * Resolves dependency names using imports, namespace context and class registry
 */
function resolveDependencies(
  dependencies: DependencyInfo[],
  imports: string[],
  currentNamespace: string,
  currentClassName: string,
  classRegistry: ClassMapping,
  file:File,
  classItem:Class
): DependencyInfo[] {
  const resolved = new Set<string>();
  const resolvedDependencies: DependencyInfo[] = [];
 

  for (const dep of dependencies) {
    // Skip primitive types and current class
    if (isPrimitiveType(dep.className) || dep.className === currentClassName) {
      continue;
    }

    // Handle generic types (extract base type)
    const baseType = dep.className.split("<")[0].trim();

    // Skip if we've already processed this dependency
    if (resolved.has(baseType)) {
      continue;
    }

    const dependencyInfo = resolveClassDependency(
      baseType,
      file.namespace,
      file.imports,
      classRegistry
    );

    if (dependencyInfo) {
      resolved.add(baseType);
      resolvedDependencies.push(dependencyInfo);
    }
  }

  return resolvedDependencies;
}

/**
 * Resolves a single class dependency
 */
function resolveClassDependency(
  baseType: string,
  currentNamespace: string,
  imports: string[],
  classRegistry: ClassMapping
): DependencyInfo | null {
  // Check if it's a fully qualified name
  if (baseType.includes(".")) {
    return resolveFullyQualifiedName(baseType, classRegistry);
  }

  // Try to resolve with current namespace
  const fromCurrentNamespace = resolveWithNamespace(
    baseType,
    currentNamespace,
    classRegistry
  );
  if (fromCurrentNamespace) {
    return fromCurrentNamespace;
  }

  // Try to resolve with imports
  const fromImports = resolveWithImports(baseType, imports, classRegistry);
  if (fromImports) {
    return fromImports;
  }

  // Default to external dependency if we have a valid type
  if (baseType) {
    return {
      className: baseType,
      namespace: "unknown",
      projectName: "external",
    };
  }

  return null;
}

/**
 * Resolves a fully qualified class name
 */
function resolveFullyQualifiedName(
  fullName: string,
  classRegistry: ClassMapping
): DependencyInfo {
  const parts = fullName.split(".");
  const className = parts.pop() ?? "";
  const namespace = parts.join(".");

  // Try to find in registry
  if (classRegistry.has(fullName)) {
    const info = classRegistry.get(fullName)!;
    return {
      className,
      namespace: info.namespace,
      projectName: info.projectName,
    };
  }

  // External dependency
  return {
    className,
    namespace,
    projectName: "external",
  };
}

/**
 * Tries to resolve a class name using the current namespace
 */
function resolveWithNamespace(
  baseType: string,
  currentNamespace: string,
  classRegistry: ClassMapping
): DependencyInfo | null {
  const fullName = currentNamespace
    ? `${currentNamespace}.${baseType}`
    : baseType;
  if (!classRegistry.has(fullName)) {
    return null;
  }

  const info = classRegistry.get(fullName)!;
  return {
    className: baseType,
    namespace: info.namespace,
    projectName: info.projectName,
  };
}

/**
 * Tries to resolve a class name using import statements
 */
function resolveWithImports(
  baseType: string,
  imports: string[],
  classRegistry: ClassMapping
): DependencyInfo | null {
  for (const imp of imports) {
    const qualifiedName = `${imp}.${baseType}`;
    if (classRegistry.has(qualifiedName)) {
      const info = classRegistry.get(qualifiedName)!;
      return {
        className: baseType,
        namespace: imp,
        projectName: info.projectName,
      };
    }
  }

  return null;
}

function flattenType(type: Type): Type[] {
  const types: Type[] = [];
  types.concat(type.subTypes.flatMap((v) => flattenType(v)));
  types.push({
    className: type.className,
    namespace: type.namespace,
    projectName: type.projectName,
    subTypes: [],
  });
  return types;
}

/**
 * parse a type and, if it is generic, any subtypes as well.
 * @param rawType The type to parse. E.g. Dictionary<string, CustomClass>
 */
function recursiveParseType(rawType: string): Type {
  let subTypes: Type[] = [];
  let baseClassName = "";
  if (rawType.indexOf("<") >= 0) {
    let first = rawType.indexOf("<");
    let last = rawType.lastIndexOf(">");
    const subParts = splitByTopLevelCommas(rawType.slice(first + 1, last));
    subParts.forEach((p) => subTypes.push(recursiveParseType(p)));
  }
  if (rawType.startsWith("(") && rawType.endsWith(")")) {
    //It's a value tuple (int, int, int);
    // We ignore this
    const subParts = splitByTopLevelCommas(
      rawType.slice(1, rawType.length - 1)
    );
    subParts.forEach((p) => subTypes.push(recursiveParseType(p)));
  } else {
    baseClassName = rawType.split("<")[0].trim();
  }
  return {
    className: baseClassName,
    namespace: "unknown",
    projectName: "external",
    subTypes: subTypes,
  };
}

/**
 * Extract inheritance dependencies from a class declaration line
 */
function extractInheritanceDependencies(line: string): Type[] | undefined {
  // Use simple character class to prevent ReDoS
  const colonIndex = line.indexOf(":");
  if (colonIndex === -1) {
    return;
  }

  const braceIndex = line.indexOf("{", colonIndex);
  const endIndex = braceIndex === -1 ? line.length : braceIndex;
  const inheritanceStr = line.substring(colonIndex + 1, endIndex).trim();

  if (!inheritanceStr) {
    return;
  }
  // Handle commas in generic arguments properly
  const parts = splitByTopLevelCommas(inheritanceStr);
  return parts
    .map((p) => recursiveParseType(p))
    .filter((p) => p.className !== "object" && p.className !== "System.Object");
}
/**
 * Extract constructor dependencies from a class declaration line
 */
function extractInlineConstructor(
  declarationLine: string
): Constructor | undefined {
  // Use simple character class to prevent ReDoS
  const startBracketIndex = declarationLine.indexOf("(");
  if (startBracketIndex === -1) {
    return;
  }

  const braceIndex = declarationLine.indexOf("{");
  if (braceIndex <= startBracketIndex) {
    return;
  } // If it looks like class x {func() } we ignore

  const endBracketIndex = declarationLine.lastIndexOf(")", startBracketIndex);
  if (endBracketIndex === -1) {
    // Something went wrong with parsing
    return;
  }
  // Both start and end brackets found.
  const parameters = processParameters(
    declarationLine.substring(startBracketIndex + 1, endBracketIndex)
  );
  parameters.filter(
    (p) => p.className !== "object" && p.className !== "System.Object"
  );
  return {
    parameters: parameters.filter(
      (p) => p.className !== "object" && p.className !== "System.Object"
    ),
    name: declarationLine.slice(
      declarationLine.lastIndexOf(" ", startBracketIndex) - 1,
      startBracketIndex
    ),
  };
}

function findNext(
  str: string,
  search: string,
  ignore: number,
  startIndex: number = 0
): number {
  let depths = [0, 0, 0, 0, 0, 0];

  for (let index = startIndex; index < str.length; index++) {
    const char = str[index];
    if (
      bracketsToIncludes(depths, ignore, char) &&
      str.startsWith(search, index)
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Split a string by commas, but ignore commas within angle brackets (for generics)
 */
function splitByTopLevelCommas(str: string): string[] {
  const result: string[] = [];
  let currentPart = "";
  let angleBracketDepth = 0;

  for (const char of str) {
    if (char === "<") {
      angleBracketDepth++;
      currentPart += char;
    } else if (char === ">") {
      angleBracketDepth--;
      currentPart += char;
    } else if (char === "," && angleBracketDepth === 0) {
      result.push(currentPart.trim());
      currentPart = "";
    } else {
      currentPart += char;
    }
  }

  if (currentPart.trim()) {
    result.push(currentPart.trim());
  }

  return result;
}

/**
 * Extract dependencies from class content
 */
function extractDependenciesFromClassContent(
  className: string,
  classContent: string[]
): ClassBody {
  // 1. Find instantiations with 'new'
  let joined = classContent.join("\n");
  const lines = findNewInstantiations(joined);
  // 2. Find static method calls
  const statics = findStaticCalls(joined);
  // 3. Find variable types, parameter types, and method return types
  // This is line by line
  const { variables, functions, constructors } = findAllTypes(
    className,
    classContent
  );
  return { lines, staticCalls: statics, variables, functions, constructors };
}

/**
 * Finds instantiations with 'new'
 */
function findNewInstantiations(content: string): Type[] {
  // Simplified regex to prevent ReDoS - match type name after 'new'
  const newRegex = REGEX.newDeclaration;
  let match;
  const types = [];
  while ((match = newRegex.exec(content)) !== null) {
    if (match[1]) {
      const type = match[1].trim();
      if (!isPrimitiveType(type) && !isSystemClass(type)) {
        types.push(recursiveParseType(type));
      }
    }
  }
  return types;
}

/**
 * Finds static method calls
 */
function findStaticCalls(content: string) {
  // Improved regex for static calls
  // E.G. MyClass.CallAMethod()
  const staticRegex = REGEX.staticMethodCall;
  let match;
  const types = [];
  while ((match = staticRegex.exec(content)) !== null) {
    const className = match[1];
    if (
      !isPrimitiveType(className) &&
      !isSystemClass(className) &&
      !["this", "base", "var", "string", "int"].includes(className)
    ) {
      types.push(recursiveParseType(className));
    }
  }
  return types;
}

/**
 * Finds all types in variable declarations, parameters, and method returns
 */
function findAllTypes(className: string, content: string[]) {
  // Split into lines to simplify analysis
  //TODO: Constructors
  const variables: Type[] = [];
  const funcs: Function[] = [];
  const constructors: Constructor[] = [];
  for (const line of content) {
    let res = processVariableDeclaration(line);
    if (res) {
      variables.push(res);
    }
    let func = processMethodSignature(line);
    if (func) {
      funcs.push(func);
      continue;
    }
    let construct = processConstructSignature(className, line);
    if (construct) {
      funcs.push(construct);
    }
  }
  return {
    variables,
    functions: funcs,
    constructors,
  };
}

/**
 * Process variable and field declarations in a line
 */
function processVariableDeclaration(line: string): Type | undefined {
  // Use fixed repetition to prevent ReDoS
  //Field is all Type x = y;
  // Property is all Type x {get; set; } = y;
  const fieldRegex = REGEX.classField;
  const propertyRegex = REGEX.classProperty;

  let declMatch = fieldRegex.exec(line);
  declMatch ??= propertyRegex.exec(line);

  if (!declMatch?.[1]) {
    return;
  }
  const type = declMatch[1].trim();
  if (!isSystemClass(type)) {
    return recursiveParseType(type);
  }
  return;
}
/**
 * Process constructors to extract parameters
 */
function processConstructSignature(
  className: string,
  line: string
): Constructor | undefined {
  // Use fixed repetition to prevent ReDoS
  const methodRegex = REGEX.classConstructor;

  const methodMatch = methodRegex.exec(line);

  if (!methodMatch) {
    return;
  }
  // Only class constructors
  if (methodMatch[1] !== className) {
    return;
  }
  let parameters = processParameters(methodMatch[2]);
  return {
    name: methodMatch[1],
    parameters,
  };
}
/**
 * Process method signatures to extract return type and parameters
 */
function processMethodSignature(line: string): Function | undefined {
  // Use fixed repetition to prevent ReDoS
  const methodRegex = REGEX.classMethod;

  const methodMatch = methodRegex.exec(line);

  if (!methodMatch) {
    return;
  }
  let returnType = processReturnType(methodMatch[1]);
  let parameters = processParameters(methodMatch[3]);
  return { returnType, parameters };
}

/**
 * Process a method's return type
 */
function processReturnType(returnType: string): Type | undefined {
  const trimmedType = returnType.trim();

  if (trimmedType === "void" || isSystemClass(trimmedType)) {
    return;
  }
  return recursiveParseType(trimmedType);
}

/**
 * Process method parameters
 */
function processParameters(params: string): Type[] {
  if (!params) {
    return [];
  }

  const paramParts = splitByTopLevelCommas(params);
  const types = [];
  for (const param of paramParts) {
    let type = addParameterTypeDependency(param);
    if (type) {
      types.push(type);
    }
  }
  return types;
}

/**
 * Add a parameter's type as a dependency if applicable
 */
function addParameterTypeDependency(param: string): Type | undefined {
  const paramParts = param.trim().split(" ");

  if (paramParts.length < 2) {
    return;
  }

  const paramType = paramParts[0].trim();

  if (!isSystemClass(paramType)) {
    return recursiveParseType(paramType);
  }
  return;
}

/**
 * Extracts imports from a C# file
 */
function extractImports(content: string): string[] {
  const imports: string[] = [];
  // Line-by-line approach is safer
  const lines = content.split("\n");

  for (const line of lines) {
    let trimmed = line.trim();
    // Simplified expression
    if (trimmed.startsWith("using ") && trimmed.endsWith(";")) {
      const usingPart = trimmed.slice(5, -1).trim(); // Extract between 'using ' and ';'
      imports.push(usingPart);
    }
    //TODO: add type aliases, which looks as follows: using Point = (int, int);
  }

  return imports;
}

/**
 * Gets the body of a class with a more robust method
 */
function getClassBody(content: string, startIndex: number): string | null {
  // let openBraces = 0;
  let startPos = -1;

  // First, find the opening brace
  for (let i = startIndex; i < content.length; i++) {
    if (content[i] === "{") {
      startPos = i;
      // openBraces = 1;
      break;
    }
  }

  if (startPos === -1) {
    return null;
  }

  let i = findNext(content, "}", BRACKETS.CURLY, startPos);
  return content.substring(startPos, i + 1);
  // Then find the matching closing brace
  // for (let i = startPos + 1; i < content.length; i++) {
  //   if (content[i] === '{') {
  //     openBraces++;
  //   } else if (content[i] === '}') {
  //     openBraces--;
  //     if (openBraces === 0) {
  //       return content.substring(startPos, i + 1);
  //     }
  //   }
  // }

  // return null; // No balanced closing brace found
}

/**
 * List of C# primitive types
 */
function isPrimitiveType(type: string): boolean {
  // Add more primitive types and .NET common types
  const primitiveTypes = [
    "int",
    "string",
    "bool",
    "float",
    "double",
    "decimal",
    "char",
    "byte",
    "sbyte",
    "short",
    "ushort",
    "uint",
    "long",
    "ulong",
    "object",
    "dynamic",
    "var",
    "void",
    "this",
    "base",
    "DateTime",
    "return",
    "Guid",
    "TimeSpan",
    "Task",
    "List",
    "Dictionary",
    "IEnumerable",
    "IList",
    "IDictionary",
    "ICollection",
  ];

  // Clean up generic markers if present
  const baseType = type.split("<")[0].trim();

  return (
    primitiveTypes.includes(baseType) ||
    baseType.startsWith("Action") ||
    baseType.startsWith("Func") ||
    baseType.startsWith("System.")
  );
}

/**
 * Checks if a type is a system class that should not be considered a dependency
 */
function isSystemClass(type: string): boolean {
  const systemClasses = [
    "Console",
    "Math",
    "Environment",
    "Thread",
    "File",
    "Directory",
    "Path",
    "Convert",
    "Enum",
    "Array",
    "String",
    "Exception",
  ];

  const baseType = type.split("<")[0].trim();
  return systemClasses.includes(baseType) || baseType.startsWith("System.");
}

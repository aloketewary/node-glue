export type DiagnosticCode = 'PROJECT_NOT_FOUND' | 'PARSE_FAILURE' | 'UNSUPPORTED_LOCKFILE' | 'UNSUPPORTED_SOURCE' | 'SOURCE_FAILURE' | 'RESOLUTION_CONFLICT' | 'INTEGRITY_MISMATCH' | 'STORE_FAILURE' | 'UNMANAGED_NODE_MODULES' | 'OWNERSHIP_UNKNOWN' | 'PUBLICATION_FAILURE' | 'MAP_FAILURE' | 'LIFECYCLE_FAILURE' | 'PROTECTED_PATH' | 'MISSING_STORE_INSTANCE' | 'STALE_PROJECT_MAP' | 'UNRESOLVED_REFERENCE' | 'CAPABILITY_UNAVAILABLE' | 'LOCK_FAILURE' | 'INVALID_INPUT';
export type DiagnosticValue = string | number | boolean | readonly string[];
export type DiagnosticContext = Readonly<Record<string, DiagnosticValue | undefined>>;
export interface Diagnostic {
    code: DiagnosticCode;
    message: string;
    context: DiagnosticContext;
    cause?: unknown;
}
export declare function sanitizeDiagnosticContext(context?: DiagnosticContext): DiagnosticContext;
export declare class NodeGlueError extends Error {
    readonly diagnostic: Diagnostic;
    readonly code: DiagnosticCode;
    readonly context: DiagnosticContext;
    constructor(code: DiagnosticCode, message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class ParseError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class UnsupportedLockfileError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class UnsupportedSourceError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class ResolutionConflictError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class IntegrityMismatchError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class UnmanagedNodeModulesError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class PublicationError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class LifecycleError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class ProtectedPathError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class CapabilityUnavailableError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class SourceFailureError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class StoreError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class OwnershipUnknownError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class MissingStoreInstanceError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class StaleProjectMapError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class ProjectMapError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class UnresolvedReferenceError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class ProjectNotFoundError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
export declare class LockError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext, cause?: unknown);
}
export declare class InvalidInputError extends NodeGlueError {
    constructor(message: string, context?: DiagnosticContext);
}
//# sourceMappingURL=errors.d.ts.map
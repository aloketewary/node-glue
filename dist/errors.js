const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|credential|cookie|api[-_]?key)/i;
const AUTHORITY_CREDENTIALS = /(https?:\/\/)([^/@\s]+):([^/@\s]+)@/gi;
function redactText(value) {
    return value.replace(AUTHORITY_CREDENTIALS, '$1[REDACTED]@');
}
export function sanitizeDiagnosticContext(context = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(context)) {
        if (value === undefined) {
            continue;
        }
        if (SENSITIVE_KEY.test(key)) {
            safe[key] = '[REDACTED]';
            continue;
        }
        if (typeof value === 'string') {
            safe[key] = redactText(value);
        }
        else if (Array.isArray(value)) {
            safe[key] = value.map((item) => redactText(item));
        }
        else {
            safe[key] = value;
        }
    }
    return safe;
}
export class NodeGlueError extends Error {
    diagnostic;
    code;
    context;
    constructor(code, message, context = {}, cause) {
        super(message);
        this.name = 'NodeGlueError';
        this.code = code;
        this.context = sanitizeDiagnosticContext(context);
        this.diagnostic = { code, message, context: this.context, ...(cause === undefined ? {} : { cause }) };
    }
}
export class ParseError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('PARSE_FAILURE', message, context, cause);
        this.name = 'ParseError';
    }
}
export class UnsupportedLockfileError extends NodeGlueError {
    constructor(message, context = {}) {
        super('UNSUPPORTED_LOCKFILE', message, context);
        this.name = 'UnsupportedLockfileError';
    }
}
export class UnsupportedSourceError extends NodeGlueError {
    constructor(message, context = {}) {
        super('UNSUPPORTED_SOURCE', message, context);
        this.name = 'UnsupportedSourceError';
    }
}
export class ResolutionConflictError extends NodeGlueError {
    constructor(message, context = {}) {
        super('RESOLUTION_CONFLICT', message, context);
        this.name = 'ResolutionConflictError';
    }
}
export class IntegrityMismatchError extends NodeGlueError {
    constructor(message, context = {}) {
        super('INTEGRITY_MISMATCH', message, context);
        this.name = 'IntegrityMismatchError';
    }
}
export class UnmanagedNodeModulesError extends NodeGlueError {
    constructor(message, context = {}) {
        super('UNMANAGED_NODE_MODULES', message, context);
        this.name = 'UnmanagedNodeModulesError';
    }
}
export class PublicationError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('PUBLICATION_FAILURE', message, context, cause);
        this.name = 'PublicationError';
    }
}
export class LifecycleError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('LIFECYCLE_FAILURE', message, context, cause);
        this.name = 'LifecycleError';
    }
}
export class ProtectedPathError extends NodeGlueError {
    constructor(message, context = {}) {
        super('PROTECTED_PATH', message, context);
        this.name = 'ProtectedPathError';
    }
}
export class CapabilityUnavailableError extends NodeGlueError {
    constructor(message, context = {}) {
        super('CAPABILITY_UNAVAILABLE', message, context);
        this.name = 'CapabilityUnavailableError';
    }
}
export class SourceFailureError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('SOURCE_FAILURE', message, context, cause);
        this.name = 'SourceFailureError';
    }
}
export class StoreError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('STORE_FAILURE', message, context, cause);
        this.name = 'StoreError';
    }
}
export class OwnershipUnknownError extends NodeGlueError {
    constructor(message, context = {}) {
        super('OWNERSHIP_UNKNOWN', message, context);
        this.name = 'OwnershipUnknownError';
    }
}
export class MissingStoreInstanceError extends NodeGlueError {
    constructor(message, context = {}) {
        super('MISSING_STORE_INSTANCE', message, context);
        this.name = 'MissingStoreInstanceError';
    }
}
export class StaleProjectMapError extends NodeGlueError {
    constructor(message, context = {}) {
        super('STALE_PROJECT_MAP', message, context);
        this.name = 'StaleProjectMapError';
    }
}
export class ProjectMapError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('MAP_FAILURE', message, context, cause);
        this.name = 'ProjectMapError';
    }
}
export class UnresolvedReferenceError extends NodeGlueError {
    constructor(message, context = {}) {
        super('UNRESOLVED_REFERENCE', message, context);
        this.name = 'UnresolvedReferenceError';
    }
}
export class ProjectNotFoundError extends NodeGlueError {
    constructor(message, context = {}) {
        super('PROJECT_NOT_FOUND', message, context);
        this.name = 'ProjectNotFoundError';
    }
}
export class LockError extends NodeGlueError {
    constructor(message, context = {}, cause) {
        super('LOCK_FAILURE', message, context, cause);
        this.name = 'LockError';
    }
}
export class InvalidInputError extends NodeGlueError {
    constructor(message, context = {}) {
        super('INVALID_INPUT', message, context);
        this.name = 'InvalidInputError';
    }
}
//# sourceMappingURL=errors.js.map
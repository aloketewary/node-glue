import type { SourceAdapter } from './adapters/source.js';
import type { DependencySource, PackageManifest, ProjectInput, ResolveOptions, ResolvedProject } from './types.js';
/** Minimal Arborist node shape consumed by Node Glue. Arborist stays behind this boundary. */
export interface ResolverNode {
    name?: string;
    version?: string;
    location?: string;
    path?: string;
    resolved?: string;
    integrity?: string;
    dev?: boolean;
    optional?: boolean;
    devOptional?: boolean;
    peer?: boolean;
    package?: Partial<PackageManifest>;
    edgesOut?: Iterable<ResolverEdge> | Map<string, ResolverEdge>;
    source?: DependencySource;
}
export interface ResolverEdge {
    name: string;
    spec: string;
    type?: string;
    optional?: boolean;
    to?: ResolverNode | null;
}
export interface ResolverTree {
    root?: ResolverNode;
    inventory?: Iterable<[string, ResolverNode]> | Map<string, ResolverNode>;
}
/** Internal adapter used to isolate @npmcli/arborist from the normalized graph. */
export interface ArboristAdapter {
    loadVirtual(input: ProjectInput, options: ResolveOptions): Promise<ResolverTree>;
    buildIdealTree(input: ProjectInput, options: ResolveOptions): Promise<ResolverTree>;
}
export interface ArboristAdapterFactory {
    create(projectRoot: string, options: ResolveOptions): ArboristAdapter;
}
export interface DependencyResolverOptions {
    /** Inject a fake or alternate Arborist boundary for tests and future resolvers. */
    arborist?: ArboristAdapter;
    arboristFactory?: ArboristAdapterFactory;
    /** Optional source boundary for source forms not fully described by a lockfile/tree node. */
    sourceAdapter?: Pick<SourceAdapter, 'resolve'>;
    now?: () => string;
}
/**
 * Default adapter for npm's tree interpreter. It never calls reify(), so Arborist
 * cannot write node_modules or run lifecycle scripts on Node Glue's behalf.
 */
export declare class NpmArboristAdapter implements ArboristAdapter {
    private readonly projectRoot;
    private readonly options;
    constructor(projectRoot: string, options: ResolveOptions);
    loadVirtual(): Promise<ResolverTree>;
    buildIdealTree(): Promise<ResolverTree>;
    private run;
}
export declare class DefaultArboristAdapterFactory implements ArboristAdapterFactory {
    create(projectRoot: string, options: ResolveOptions): ArboristAdapter;
}
/**
 * Resolves an npm tree into Node Glue's source-aware, placement-preserving graph.
 * Arborist is used only for no-lockfile ideal-tree construction; lockfile inputs
 * are normalized directly from InputReader's already validated representation.
 */
export declare class DependencyResolver {
    private readonly options;
    constructor(options?: DependencyResolverOptions);
    resolve(input: ProjectInput, options?: ResolveOptions): Promise<ResolvedProject>;
    private graphFromArborist;
    private graphFromLockfile;
    private includeNode;
    private sourceForNode;
    private validateRootDependencies;
    private validateDependencies;
    private peerContext;
}
//# sourceMappingURL=dependency-resolver.d.ts.map
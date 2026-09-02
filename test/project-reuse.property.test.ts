import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { ProjectMapRepository } from '../src/project-map.js';
import { ProjectStateRepository } from '../src/state.js';
import type { DependencyPlacement, ProjectMap, ProjectState } from '../src/types.js';
import { createFakeFileSystem, propertyTag } from './fixtures/index.js';

interface ReuseCase {
  readonly projectId: number;
  readonly initialLockfileId: number;
  readonly changedLockfileId: number;
  readonly placementCount: number;
  readonly generationId: number;
}

interface MaterializationSnapshot {
  readonly generation: string;
  readonly activeTarget: string;
}

interface EnsureResult {
  readonly map: ProjectMap;
  readonly state: ProjectState;
  readonly materialization: MaterializationSnapshot;
  readonly reused: boolean;
}

const reuseCaseArbitrary: fc.Arbitrary<ReuseCase> = fc
  .record({
    projectId: fc.integer({ min: 0, max: 999_999 }),
    initialLockfileId: fc.integer({ min: 0, max: 999_999 }),
    changedLockfileId: fc.integer({ min: 0, max: 999_999 }),
    placementCount: fc.integer({ min: 1, max: 6 }),
    generationId: fc.integer({ min: 0, max: 999_999 })
  })
  .filter(({ initialLockfileId, changedLockfileId }) => initialLockfileId !== changedLockfileId);

describe('project reuse property coverage', () => {
  it(propertyTag(7, 'unchanged projects are idempotent'), async () => {
    await fc.assert(
      fc.asyncProperty(reuseCaseArbitrary, async (reuseCase) => {
        const filesystem = createFakeFileSystem('/fixture');
        const projectRoot = `/fixture/projects/project-${reuseCase.projectId}`;
        await filesystem.mkdir(projectRoot, { recursive: true });

        const mapRepository = new ProjectMapRepository({
          filesystem,
          projectsDir: '/fixture/store/projects'
        });
        const stateRepository = new ProjectStateRepository({
          filesystem,
          projectsDir: '/fixture/store/projects'
        });
        const acquisition = new CountingAcquisition();
        const materializer = new CountingMaterializer(filesystem);
        const ensure = new FixtureEnsure({
          filesystem,
          mapRepository,
          stateRepository,
          acquisition,
          materializer
        });

        const first = await ensure.run({
          projectRoot,
          lockfileHash: `lock-${reuseCase.initialLockfileId}`,
          placements: createPlacements(reuseCase)
        });
        const mapAfterFirst = await mapRepository.read(first.map.projectId);
        const stateAfterFirst = await stateRepository.read(first.map.projectId);
        if (mapAfterFirst === undefined || stateAfterFirst === undefined) {
          throw new Error('First ensure must publish map and state.');
        }

        const second = await ensure.run({
          projectRoot,
          lockfileHash: `lock-${reuseCase.initialLockfileId}`,
          placements: createPlacements(reuseCase)
        });

        expect(second.reused).toBe(true);
        expect(acquisition.calls).toBe(1);
        expect(materializer.calls).toBe(1);
        expect(second.map).toEqual(mapAfterFirst);
        expect(second.state).toEqual(stateAfterFirst);
        expect(second.materialization).toEqual(first.materialization);
        expect(await mapRepository.read(first.map.projectId)).toEqual(mapAfterFirst);
        expect(await stateRepository.read(first.map.projectId)).toEqual(stateAfterFirst);

        let stateObservedBeforeAcquisition: ProjectState | undefined;
        acquisition.beforeAcquire = async () => {
          stateObservedBeforeAcquisition = await stateRepository.read(first.map.projectId);
        };

        const changed = await ensure.run({
          projectRoot,
          lockfileHash: `lock-${reuseCase.changedLockfileId}`,
          placements: createPlacements(reuseCase)
        });

        expect(changed.reused).toBe(false);
        expect(acquisition.calls).toBe(2);
        expect(materializer.calls).toBe(2);
        expect(stateObservedBeforeAcquisition).toMatchObject({
          projectId: first.map.projectId,
          projectRoot,
          status: 'incomplete'
        });
        expect(stateObservedBeforeAcquisition?.activeTarget).toBeUndefined();
        expect(stateObservedBeforeAcquisition?.lastSuccessfulMapGeneration).toBeUndefined();
        expect(stateObservedBeforeAcquisition?.lastSuccessfulMaterializationGeneration).toBeUndefined();
        expect(changed.map.lockfileHash).toBe(`lock-${reuseCase.changedLockfileId}`);
        expect(changed.map).not.toEqual(first.map);
        expect(changed.state.status).toBe('ready');
        expect(changed.state.activeTarget).toBe(changed.materialization.activeTarget);
      }),
      { numRuns: 100 }
    );
  });
});

class CountingAcquisition {
  calls = 0;
  beforeAcquire: (() => Promise<void>) | undefined;

  async acquire(): Promise<void> {
    if (this.beforeAcquire !== undefined) await this.beforeAcquire();
    this.calls += 1;
  }
}

class CountingMaterializer {
  calls = 0;

  constructor(private readonly filesystem: ReturnType<typeof createFakeFileSystem>) {}

  async materialize(map: ProjectMap, generationId: string): Promise<MaterializationSnapshot> {
    this.calls += 1;
    const generation = `generation-${generationId}-${this.calls}`;
    const activeTarget = `/fixture/store/projects/${map.projectId}/generations/${generation}/node_modules`;
    await this.filesystem.mkdir(activeTarget, { recursive: true });
    return { generation, activeTarget };
  }
}

class FixtureEnsure {
  constructor(private readonly dependencies: {
    filesystem: ReturnType<typeof createFakeFileSystem>;
    mapRepository: ProjectMapRepository;
    stateRepository: ProjectStateRepository;
    acquisition: CountingAcquisition;
    materializer: CountingMaterializer;
  }) {}

  async run(input: {
    projectRoot: string;
    lockfileHash: string;
    placements: readonly DependencyPlacement[];
  }): Promise<EnsureResult> {
    const projectId = await this.dependencies.mapRepository.projectIdFor(input.projectRoot);
    const existingMap = await this.dependencies.mapRepository.read(projectId);
    const existingState = await this.dependencies.stateRepository.read(projectId);

    if (
      existingMap?.lockfileHash === input.lockfileHash &&
      existingState?.status === 'ready' &&
      existingState.activeTarget !== undefined &&
      await this.dependencies.filesystem.exists(existingState.activeTarget)
    ) {
      return {
        map: existingMap,
        state: existingState,
        materialization: {
          generation: existingState.lastSuccessfulMaterializationGeneration ?? '',
          activeTarget: existingState.activeTarget
        },
        reused: true
      };
    }

    if (existingState !== undefined) {
      await this.dependencies.stateRepository.publish({
        schemaVersion: 1,
        projectId,
        projectRoot: input.projectRoot,
        updatedAt: '2025-01-02T00:00:00.000Z',
        status: 'incomplete'
      });
    }

    await this.dependencies.acquisition.acquire();
    const map = await this.dependencies.mapRepository.publish({
      schemaVersion: 1,
      projectId,
      projectRoot: input.projectRoot,
      lockfileHash: input.lockfileHash,
      placements: input.placements,
      generatedAt: `2025-01-01T00:00:${input.lockfileHash.slice(5).padStart(2, '0')}.000Z`,
      toolVersion: '0.1.0'
    });
    const materialization = await this.dependencies.materializer.materialize(map, input.lockfileHash);
    const state = await this.dependencies.stateRepository.publish({
      schemaVersion: 1,
      projectId: map.projectId,
      projectRoot: map.projectRoot,
      lastSuccessfulMapGeneration: map.generatedAt,
      lastSuccessfulMaterializationGeneration: materialization.generation,
      activeTarget: materialization.activeTarget,
      updatedAt: map.generatedAt,
      lastSuccessfulAt: map.generatedAt,
      status: 'ready'
    });

    return { map, state, materialization, reused: false };
  }
}

function createPlacements(reuseCase: ReuseCase): readonly DependencyPlacement[] {
  return Array.from({ length: reuseCase.placementCount }, (_, index) => ({
    relativePath: `node_modules/@fixture/package-${reuseCase.projectId}-${index}`,
    packageIdentityHash: `${reuseCase.projectId.toString(16).padStart(6, '0')}${index.toString(16).padStart(2, '0')}`,
    packageName: `@fixture/package-${reuseCase.projectId}-${index}`
  }));
}

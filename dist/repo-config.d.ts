export declare const DEFAULT_CONFIG_FILE = ".github/universal-code-reviewer.yml";
export declare const DEFAULT_ACTION_MAX_DIFF_SIZE = 50000;
export declare const DEFAULT_ACTION_MAX_COMMENTS = 25;
export interface RepoConfig {
    maxDiffSize?: number;
    maxComments?: number;
    skipPaths?: string[];
    jsonResponseMode?: boolean;
}
export declare function parseRepoConfigYaml(text: string): RepoConfig;
export declare function resolveMaxDiffSize(actionInput: string, repoConfig?: RepoConfig): number;
export declare function resolveMaxComments(actionInput: string, repoConfig?: RepoConfig): number;
export declare function resolveJsonResponseMode(actionInput: string, repoConfig?: RepoConfig): boolean;
//# sourceMappingURL=repo-config.d.ts.map
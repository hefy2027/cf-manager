/**
 * catalogDeploy.ts — 部署逻辑已迁移到 deploy/ 子模块。
 * 此文件仅保留 re-export 以维持向后兼容。
 */
export { deployTemplate, preflightDeploy } from './deploy';
export type { DeployOptions } from './deploy';

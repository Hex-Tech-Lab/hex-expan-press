/**
 * QA-Intel Rule Registry & Ledger (v1.0)
 *
 * All production rules are exported from this unified index. The following
 * rule ledger documents the current state as of 2026-06-29.
 *
 * RULE COUNT AUDIT (55 total rules):
 * - Architecture Rules: 11
 *   - HexagonalBoundaryRule, ComplexityRule, ErrorTaxonomyRule, CrossPlatformRule,
 *   - SchemaContractRule, RedundantValidationRule, WorkflowRule,
 *   - TranscriptUnsafeAccessRule, HardcodedDomainLogicRule, StateSyncRule,
 *   - GraphAwareBoundaryRule
 *
 * - Security Rules: 13
 *   - CredentialLeakRule, SanitizationRule, SecretsExposureRule, AuthSecurityRule,
 *   - HmacMessageFormatRule, UnsafePropertyAccessRule, EnvPlaceholderNamespaceRule,
 *   - InsecureFallbackRule, SqlInjectionRule, WhitelistPathSanitizationRule,
 *   - InformationDisclosureRule, YamlInjectionRule, ReservedKeywordRule
 *
 * - Streaming Rules: 7
 *   - StreamResilienceRule, BundleContradictionRule, TranscriptGuardRule,
 *   - StreamSettleRule, CascadeOrderRule, ProxyPromotionRule,
 *   - ModuleLevelDynamicImportRule
 *
 * - Persistence Rules: 5
 *   - PersistResilienceRule, PersistAbortScopeRule, RetryFlagInterferenceRule,
 *   - QuorumTimeoutCompletionRule, StaleStateResetRule
 *
 * - UI Rules: 10
 *   - InpAlertBlockerRule, CanvasHoverReRenderRule, OverlayCloseCascadeRule,
 *   - ValidationOnChangeRule, UnhandledClipboardPromiseRule,
 *   - StartTransitionWrappingRule, ToastAccessibilityRule, SwallowedErrorRule,
 *   - SyncImportBeforeRedirectRule, CanvasStaleDataRule
 *
 * - Quality Rules: 6
 *   - AsyncWithoutAwaitRule, DeadCodeRule, VariableNamingRule,
 *   - TimeoutCleanupRule, ImportOrderingRule, ErrorObservabilityRule
 *
 * - Data Integrity Rules: 3
 *   - DatabaseConstraintRule, DefaultValueConsistencyRule, TruncationValidationRule
 *
 * MAINTENANCE NOTES:
 * - Dead module files (ArchitectureRuleEngine.ts, etc.) have been removed.
 * - All rules are now single-responsibility and independently exported.
 * - Rule count is verified via automated test in calibration suite.
 */

export { HexagonalBoundaryRule, ComplexityRule, ErrorTaxonomyRule, CrossPlatformRule, SchemaContractRule, RedundantValidationRule, WorkflowRule, TranscriptUnsafeAccessRule, HardcodedDomainLogicRule, StateSyncRule, GraphAwareBoundaryRule } from "./architecture";
export { CredentialLeakRule, SanitizationRule, SecretsExposureRule, AuthSecurityRule, HmacMessageFormatRule, UnsafePropertyAccessRule, EnvPlaceholderNamespaceRule, InsecureFallbackRule, SqlInjectionRule, WhitelistPathSanitizationRule, InformationDisclosureRule, YamlInjectionRule, ReservedKeywordRule, AuthorizationRegexBypassRule } from "./security";
export { StreamResilienceRule, BundleContradictionRule, TranscriptGuardRule, StreamSettleRule, CascadeOrderRule, ProxyPromotionRule, ModuleLevelDynamicImportRule } from "./streaming";
export { PersistResilienceRule, PersistAbortScopeRule, RetryFlagInterferenceRule, QuorumTimeoutCompletionRule, StaleStateResetRule } from "./persistence";
export { InpAlertBlockerRule, CanvasHoverReRenderRule, OverlayCloseCascadeRule, ValidationOnChangeRule, UnhandledClipboardPromiseRule, StartTransitionWrappingRule, ToastAccessibilityRule, SwallowedErrorRule, SyncImportBeforeRedirectRule, CanvasStaleDataRule, ZustandWholeStoreInEffectDepsRule } from "./ui";
export { AsyncWithoutAwaitRule, DeadCodeRule, VariableNamingRule, TimeoutCleanupRule, ImportOrderingRule, ErrorObservabilityRule } from "./quality";
export { DatabaseConstraintRule, DefaultValueConsistencyRule, TruncationValidationRule } from "./data-integrity";
export { SecurityFixWithoutTestRule, NonNullAfterArraySortFilterRule } from "./security-lessons-20260905";
export { JsonbReadModifyWriteRule, UntrustedLogInterpolationRule, ConflictMarkerRule } from "./data-lessons-20260924";
export { SqlSecurityDefinerCallerKeyRule, SqlDropFunctionDefaultArgRule } from "./sql-migrations";
export { HardcodedTierGrantRule, UntrustedTierFallbackRule, ServiceRoleAnonFallbackRule, RuntimeTierTrustRule } from "./security-lessons-20260924";
export { AdvisoryLockIsolationGuardRule, IpHeaderSinkRule, LaunchPathIsolationLiteralRule } from "./security-lessons-20261010";
export { SilentDefaultOnExternalResponseRule, ServerFetchWithoutTimeoutRule, ErrorPathAsymmetryRule, SuccessGuardedPersistenceRule } from "./reliability-lessons-20260924";
export { UnconsumedStreamLeakRule, UnboundedBodyReadRule, NonIdempotentRetryRule, FailOpenUndefinedFilterRule } from "./artas-rules";
export { StreamReaderWithoutFinallyRule, UnregisteredSettingsKeyRule } from "./lessons-20261009";

export enum RiskLevel {
	LOW = 0,
	MEDIUM = 1,
	HIGH = 2,
	CRITICAL = 3,
}

export const RISK_LABELS: Record<RiskLevel, string> = {
	[RiskLevel.LOW]: "LOW",
	[RiskLevel.MEDIUM]: "MEDIUM",
	[RiskLevel.HIGH]: "HIGH",
	[RiskLevel.CRITICAL]: "CRITICAL",
};

export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel =>
	a >= b ? a : b;

export const minLevel = (a: RiskLevel, b: RiskLevel): RiskLevel =>
	a <= b ? a : b;

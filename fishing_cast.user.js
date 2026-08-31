// ==UserScript==
// @name         Arcane Angler 自动抛竿
// @namespace    https://github.com/simbary
// @version      4.21
// @author       Codex
// @description  自动化钓鱼操作
// @downloadURL  https://raw.githubusercontent.com/simbary/scripts/main/fishing_cast.user.js
// @updateURL    https://raw.githubusercontent.com/simbary/scripts/main/fishing_cast.user.js
// @match        https://arcaneangler.com/*
// @match        https://www.arcaneangler.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      qyapi.weixin.qq.com
// @run-at       document-start
// ==/UserScript==

/* 此文件由 pnpm build 自动生成，请修改 arcaneangler/src 下的源码。 */
/**
 * 免责声明：
 * 本脚本仅供学习与个人研究使用。使用者应自行遵守目标网站的服务条款、
 * 使用规则及所在地法律法规。因使用本脚本产生的账号限制、数据损失或
 * 其他直接、间接后果，均由使用者自行承担，脚本作者不承担相关责任。
 */

(function() {
	"use strict";
	var DEFAULT_BAIT_ID = "bait_default";
	var GOLD_BREEZE_WEATHER$1 = "gold_breeze";
	var PURCHASE_RETRY_DELAY = 6e4;
	var BAIT_GRADE_LABELS = {
		default: "默认饵",
		low: "低级饵",
		medium: "中级饵（+250 幸运）",
		high: "高级饵（+500 幸运）",
		super: "超级饵（+1000 幸运）"
	};
	var AUTO_BAIT_CONTEXT_LABELS = {
		guild: "公会赛",
		personal: "个人赛",
		regular: "常规"
	};
	function normalizeBiomeId$2(value) {
		const biomeId = Number(value);
		return Number.isInteger(biomeId) && biomeId > 0 ? biomeId : null;
	}
	function normalizeQuantity$1(value) {
		const quantity = Number(value);
		return Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : 0;
	}
	function getBaitIdForBiome(biomeId, baitGrade) {
		if (baitGrade === "default") return DEFAULT_BAIT_ID;
		const normalizedBiomeId = normalizeBiomeId$2(biomeId);
		return normalizedBiomeId ? `bait_${normalizedBiomeId}_${baitGrade}` : null;
	}
	function getAutoBaitContext(biomeId, competitionBiomes) {
		const normalizedBiomeId = normalizeBiomeId$2(biomeId);
		if (normalizedBiomeId && normalizedBiomeId === normalizeBiomeId$2(competitionBiomes?.guildTournamentBiomeId)) return "guild";
		if (normalizedBiomeId && normalizedBiomeId === normalizeBiomeId$2(competitionBiomes?.personalDerbyBiomeId)) return "personal";
		return "regular";
	}
	function getBaitGradeForBiome(biomeId, autoBaitSettings, competitionBiomes, automationState = {}) {
		return autoBaitSettings?.baitGrade ?? 'low';
	}
	function shouldPurchaseBait(quantity, minimumQuantity, baitGrade) {
		return baitGrade !== "default" && normalizeQuantity$1(quantity) < normalizeQuantity$1(minimumQuantity);
	}
	function getBaitById$1(baitId) {
		if (typeof unsafeWindow.getBaitById === "function") try {
			const bait = unsafeWindow.getBaitById(baitId);
			if (bait) return bait;
		} catch {}
		return Array.isArray(unsafeWindow.BAITS) ? unsafeWindow.BAITS.find((bait) => bait?.id === baitId) : null;
	}
	function getBaitLabel(baitId, baitGrade, biomeId) {
		const catalogName = String(getBaitById$1(baitId)?.name ?? "").trim();
		const gradeLabel = BAIT_GRADE_LABELS[baitGrade] ?? baitGrade;
		if (baitGrade === "default") return catalogName ? `${gradeLabel}（${catalogName}）` : gradeLabel;
		return `[B${biomeId}] ${gradeLabel}${catalogName ? `（${catalogName}）` : ""}`;
	}
	function getErrorMessage$2(error) {
		return String(error?.message ?? error ?? "未知错误");
	}
	function createAutoBaitController({ getPlayer, getState, onStateChange }) {
		let checking = false;
		let currentBaitId = null;
		let currentQuantity = null;
		let lastCheckedAt = 0;
		let lastPurchasedAt = 0;
		let retryAfter = 0;
		let retryBaitId = null;
		let status = "未启用";
		let checkQueue = Promise.resolve();
		const pendingPurchaseQuantities = new Map();
		function notifyStateChanged() {
			onStateChange?.();
		}
		function updateSnapshot({ baitId, quantity, nextStatus }) {
			if (baitId !== void 0) currentBaitId = baitId;
			if (quantity !== void 0) currentQuantity = quantity;
			if (nextStatus !== void 0) status = nextStatus;
			notifyStateChanged();
		}
		function getSnapshot() {
			return {
				autoBaitCurrentBaitId: currentBaitId,
				autoBaitCurrentQuantity: currentQuantity,
				autoBaitLastCheckedAt: lastCheckedAt,
				autoBaitLastPurchasedAt: lastPurchasedAt,
				autoBaitStatus: status
			};
		}
		async function equipBait(api, player, baitId, baitLabel) {
			if (player.equippedBait === baitId) return;
			const result = await api.equipBait(baitId);
			if (result?.success !== true) throw new Error(result?.message ?? `无法装备${baitLabel}`);
		}
		async function evaluate({ baitGrade: requestedBaitGrade = null, biomeId: requestedBiomeId = null, contextLabel: requestedContextLabel = null, force = false }) {
			const state = getState();
			const { autoBaitSettings, autoBiomeCompetitionBiomes, enabled } = state;
			if (!autoBaitSettings.enabled) {
				updateSnapshot({
					baitId: null,
					quantity: null,
					nextStatus: "未启用"
				});
				return false;
			}
			if (!enabled) {
				updateSnapshot({
					baitId: null,
					quantity: null,
					nextStatus: "脚本启动后自动检查"
				});
				return false;
			}
			const api = unsafeWindow.ApiService;
			if (typeof api?.equipBait !== "function") {
				updateSnapshot({ nextStatus: "等待游戏鱼饵接口" });
				return false;
			}
			const player = getPlayer?.();
			if (!player) {
				updateSnapshot({ nextStatus: "等待游戏角色数据" });
				return false;
			}
			checking = true;
			updateSnapshot({ nextStatus: "正在检查鱼饵库存" });
			let attemptedBaitId = null;
			try {
				const biomeId = normalizeBiomeId$2(requestedBiomeId) ?? normalizeBiomeId$2(player?.currentBiome);
				const baitContext = getAutoBaitContext(biomeId, autoBiomeCompetitionBiomes);
				const baitGrade = Object.hasOwn(BAIT_GRADE_LABELS, requestedBaitGrade) ? requestedBaitGrade : getBaitGradeForBiome(biomeId, autoBaitSettings, autoBiomeCompetitionBiomes, state);
				const baitId = getBaitIdForBiome(biomeId, baitGrade);
				attemptedBaitId = baitId;
				if (!baitId) throw new Error("无法识别当前地图");
				if (!force && baitId === retryBaitId && Date.now() < retryAfter) return false;
				if (baitGrade !== "default" && typeof api?.buyBait !== "function") {
					updateSnapshot({ nextStatus: "等待游戏鱼饵购买接口" });
					return false;
				}
				const baitLabel = getBaitLabel(baitId, baitGrade, biomeId);
				const contextLabel = requestedContextLabel ?? (state.autoBiomeWeatherByBiome?.[biomeId]?.weather === GOLD_BREEZE_WEATHER$1 ? "金风" : AUTO_BAIT_CONTEXT_LABELS[baitContext]);
				const minimumQuantity = normalizeQuantity$1(autoBaitSettings.minimumQuantity);
				lastCheckedAt = Date.now();
				if (baitGrade === "default") {
					await equipBait(api, player, baitId, baitLabel);
					retryAfter = 0;
					retryBaitId = null;
					updateSnapshot({
						baitId,
						quantity: null,
						nextStatus: `${contextLabel} · ${baitLabel} · 无限`
					});
					return true;
				}
				let quantity = normalizeQuantity$1(player?.baitInventory?.[baitId]);
				const pendingPurchaseQuantity = pendingPurchaseQuantities.get(baitId);
				if (pendingPurchaseQuantity !== void 0 && quantity < pendingPurchaseQuantity) quantity = pendingPurchaseQuantity;
				else if (pendingPurchaseQuantity !== void 0) pendingPurchaseQuantities.delete(baitId);
				let purchased = false;
				if (shouldPurchaseBait(quantity, minimumQuantity, baitGrade)) {
					const bait = getBaitById$1(baitId);
					const totalCost = Number(bait?.price) * autoBaitSettings.purchaseQuantity;
					if (Number.isFinite(totalCost) && totalCost > Number(player?.gold ?? 0)) {
						await equipBait(api, player, DEFAULT_BAIT_ID, getBaitLabel(DEFAULT_BAIT_ID, "default", biomeId));
						retryBaitId = baitId;
						retryAfter = Date.now() + PURCHASE_RETRY_DELAY;
						updateSnapshot({
							baitId,
							quantity,
							nextStatus: `${contextLabel} ${baitLabel}不足，购买需 ${totalCost.toLocaleString()} 金币，已切换免费饵`
						});
						return true;
					}
					updateSnapshot({
						baitId,
						quantity,
						nextStatus: `正在购买 ${baitLabel} ×${autoBaitSettings.purchaseQuantity}`
					});
					const result = await api.buyBait(baitId, autoBaitSettings.purchaseQuantity);
					if (result?.success !== true) throw new Error(result?.message ?? "游戏未确认购买成功");
					quantity = Number.isFinite(Number(result.newBaitQuantity)) ? normalizeQuantity$1(result.newBaitQuantity) : quantity + autoBaitSettings.purchaseQuantity;
					pendingPurchaseQuantities.set(baitId, quantity);
					lastPurchasedAt = Date.now();
					purchased = true;
				}
				if (shouldPurchaseBait(quantity, minimumQuantity, baitGrade)) {
					updateSnapshot({
						baitId,
						quantity,
						nextStatus: `已补充${contextLabel} ${baitLabel}，当前 ${quantity.toLocaleString()} 个，继续补足设定阈值 ${minimumQuantity.toLocaleString()} 个`
					});
					return false;
				}
				await equipBait(api, player, baitId, baitLabel);
				retryAfter = 0;
				retryBaitId = null;
				updateSnapshot({
					baitId,
					quantity,
					nextStatus: purchased ? `已购买${contextLabel} ${baitLabel}，当前 ${quantity.toLocaleString()} 个` : `${contextLabel} · ${baitLabel} · ${quantity.toLocaleString()} 个`
				});
				return true;
			} catch (error) {
				console.error("[自动买鱼饵] 检查或购买失败：", error);
				retryBaitId = attemptedBaitId ?? currentBaitId;
				retryAfter = Date.now() + PURCHASE_RETRY_DELAY;
				updateSnapshot({ nextStatus: `鱼饵处理失败：${getErrorMessage$2(error)}` });
				return false;
			} finally {
				checking = false;
			}
		}
		function checkNow(options = {}) {
			checkQueue = checkQueue.then(() => evaluate(options), () => evaluate(options));
			return checkQueue;
		}
		function handleCastResult(result, { baitGrade: requestedBaitGrade = null, contextLabel: requestedContextLabel = null } = {}) {
			const state = getState();
			const { autoBaitSettings, autoBiomeCompetitionBiomes, enabled } = state;
			if (!autoBaitSettings.enabled || !enabled) return;
			const biomeId = normalizeBiomeId$2(result?.currentBiome);
			const baitContext = getAutoBaitContext(biomeId, autoBiomeCompetitionBiomes);
			const hasRequestedBaitGrade = Object.hasOwn(BAIT_GRADE_LABELS, requestedBaitGrade);
			const baitGrade = hasRequestedBaitGrade ? requestedBaitGrade : getBaitGradeForBiome(biomeId, autoBaitSettings, autoBiomeCompetitionBiomes, state);
			const baitId = getBaitIdForBiome(biomeId, baitGrade);
			const nextCheckOptions = hasRequestedBaitGrade ? {
				baitGrade,
				biomeId,
				contextLabel: requestedContextLabel
			} : { biomeId };
			if (!baitId) return;
			if (result?.equippedBait !== baitId) {
				checkNow(nextCheckOptions);
				return;
			}
			lastCheckedAt = Date.now();
			const contextLabel = requestedContextLabel ?? (state.autoBiomeWeatherByBiome?.[biomeId]?.weather === GOLD_BREEZE_WEATHER$1 ? "金风" : AUTO_BAIT_CONTEXT_LABELS[baitContext]);
			if (baitGrade === "default") {
				updateSnapshot({
					baitId,
					quantity: null,
					nextStatus: `${contextLabel} · ${BAIT_GRADE_LABELS.default} · 无限`
				});
				return;
			}
			const quantity = normalizeQuantity$1(result?.baitQuantity);
			const baitLabel = getBaitLabel(baitId, baitGrade, biomeId);
			pendingPurchaseQuantities.delete(baitId);
			updateSnapshot({
				baitId,
				quantity,
				nextStatus: `${contextLabel} · ${baitLabel} · ${quantity.toLocaleString()} 个`
			});
			if (shouldPurchaseBait(quantity, autoBaitSettings.minimumQuantity, baitGrade)) checkNow(nextCheckOptions);
		}
		return {
			checkNow,
			getSnapshot,
			handleCastResult,
			handleStateChanged(options = {}) {
				return checkNow(options);
			},
			isChecking() {
				return checking;
			},
			prepareGameAutoFishing(baitGrade) {
				if (getState().autoBaitSettings.enabled !== true) return Promise.resolve(true);
				return checkNow(baitGrade === "auto" ? {} : {
					baitGrade,
					contextLabel: "内置自动钓鱼"
				});
			}
		};
	}
	var AUTO_BIOME_PRIORITY_IDS = {
		guildCompetition: "guildCompetition",
		personalCompetition: "personalCompetition",
		arcaneSurge: "arcaneSurge",
		goldBreeze: "goldBreeze",
		dailyQuest: "dailyQuest",
		weightedExperience: "weightedExperience"
	};
	var AUTO_BIOME_PRIORITY_OPTIONS = [
		{
			id: AUTO_BIOME_PRIORITY_IDS.guildCompetition,
			label: "公会赛"
		},
		{
			id: AUTO_BIOME_PRIORITY_IDS.personalCompetition,
			label: "个人赛"
		},
		{
			id: AUTO_BIOME_PRIORITY_IDS.arcaneSurge,
			label: "奥术涌动"
		},
		{
			id: AUTO_BIOME_PRIORITY_IDS.goldBreeze,
			label: "金风"
		},
		{
			id: AUTO_BIOME_PRIORITY_IDS.dailyQuest,
			label: "每日任务"
		},
		{
			id: AUTO_BIOME_PRIORITY_IDS.weightedExperience,
			label: "加权经验对比"
		}
	];
	var DEFAULT_AUTO_BIOME_PRIORITY_ORDER = AUTO_BIOME_PRIORITY_OPTIONS.map(({ id }) => id);
	var AUTO_BIOME_PRIORITY_ID_SET = new Set(DEFAULT_AUTO_BIOME_PRIORITY_ORDER);
	function normalizeAutoBiomePriorityOrder(priorityOrder) {
		if (!Array.isArray(priorityOrder)) return [...DEFAULT_AUTO_BIOME_PRIORITY_ORDER];
		const normalizedOrder = [];
		for (const priorityId of priorityOrder) if (AUTO_BIOME_PRIORITY_ID_SET.has(priorityId) && !normalizedOrder.includes(priorityId)) normalizedOrder.push(priorityId);
		for (const priorityId of DEFAULT_AUTO_BIOME_PRIORITY_ORDER) if (!normalizedOrder.includes(priorityId)) normalizedOrder.push(priorityId);
		return normalizedOrder;
	}
	function getAutoBiomeDecisionOrder(priorityOrder) {
		const normalizedOrder = normalizeAutoBiomePriorityOrder(priorityOrder);
		const weightedExperienceIndex = normalizedOrder.indexOf(AUTO_BIOME_PRIORITY_IDS.weightedExperience);
		return normalizedOrder.slice(0, weightedExperienceIndex + 1);
	}
	function isAutoBiomePriorityEnabled(priorityOrder, priorityId) {
		if (priorityId === AUTO_BIOME_PRIORITY_IDS.weightedExperience) return true;
		return getAutoBiomeDecisionOrder(priorityOrder).includes(priorityId);
	}
	var WEATHER_LABELS = {
		clear: "晴朗",
		rain: "雨天",
		windy: "大风",
		foggy: "大雾",
		heatwave: "热浪",
		storm: "暴风",
		blight: "枯萎",
		gold_breeze: "金风",
		arcane_surge: "奥术涌动"
	};
	var COMPETITION_HOOK_DEBOUNCE = 1e3;
	var DAILY_QUEST_FALLBACK_FRESHNESS = 3600 * 1e3;
	var ARCANE_SURGE_WEATHER = "arcane_surge";
	var GOLD_BREEZE_WEATHER = "gold_breeze";
	var MASTERY_XP_BONUS_PER_LEVEL = 5;
	function normalizeBiomeId$1(value) {
		const biomeId = Number(value);
		return Number.isInteger(biomeId) && biomeId > 0 ? biomeId : null;
	}
	function normalizeXpBonus(value) {
		const xpBonus = Number(value);
		return Number.isFinite(xpBonus) ? xpBonus : 0;
	}
	function normalizeQuestMetadata(value) {
		if (value && typeof value === "object" && !Array.isArray(value)) return value;
		if (typeof value === "string") try {
			const metadata = JSON.parse(value);
			return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
		} catch {
			return {};
		}
		return {};
	}
	function isQuestCompleted(quest) {
		if (quest?.completed === true || quest?.completed === 1 || quest?.completed === "1") return true;
		const currentProgress = Number(quest?.current_progress);
		const targetAmount = Number(quest?.target_amount);
		return Number.isFinite(currentProgress) && Number.isFinite(targetAmount) && targetAmount > 0 && currentProgress >= targetAmount;
	}
	function getDailyQuestSource(payload) {
		if (Array.isArray(payload?.quests?.daily)) return payload.quests.daily;
		if (Array.isArray(payload?.daily)) return payload.daily;
		return null;
	}
	function normalizeDailyQuests(payload) {
		const source = getDailyQuestSource(payload);
		if (!source) return [];
		return source.filter((quest) => quest && typeof quest === "object").map((quest) => {
			const metadata = normalizeQuestMetadata(quest.metadata);
			const weatherRule = String(metadata.weather_rule ?? metadata.weatherRule ?? quest.weather_rule ?? quest.weatherRule ?? "").trim();
			return {
				completed: isQuestCompleted(quest),
				expiresAt: String(quest.expires_at ?? "").trim() || null,
				id: quest.id ?? quest.quest_template_id ?? null,
				targetBiome: normalizeBiomeId$1(metadata.targetBiome ?? metadata.target_biome ?? quest.targetBiome ?? quest.target_biome),
				weatherRule: weatherRule || null
			};
		});
	}
	function isDailyQuestActive(quest, now) {
		if (quest.completed) return false;
		const expiresAt = Date.parse(quest.expiresAt);
		return !Number.isFinite(expiresAt) || expiresAt > now;
	}
	function findMatchingDailyQuests({ biomeId, dailyQuests, now = Date.now(), weather }) {
		const normalizedBiomeId = normalizeBiomeId$1(biomeId);
		if (!normalizedBiomeId || !Array.isArray(dailyQuests)) return [];
		return dailyQuests.filter((quest) => {
			if (!isDailyQuestActive(quest, now)) return false;
			const hasBiomeRule = quest.targetBiome !== null;
			const hasWeatherRule = Boolean(quest.weatherRule);
			if (!hasBiomeRule && !hasWeatherRule) return false;
			return (!hasBiomeRule || quest.targetBiome === normalizedBiomeId) && (!hasWeatherRule || quest.weatherRule === weather);
		});
	}
	function normalizeWeatherByBiome(payload) {
		const source = payload?.weather ?? payload;
		if (!source || typeof source !== "object" || Array.isArray(source)) return {};
		const weatherByBiome = {};
		for (const [rawBiomeId, rawWeather] of Object.entries(source)) {
			const biomeId = normalizeBiomeId$1(rawBiomeId);
			if (!biomeId || !rawWeather || typeof rawWeather !== "object") continue;
			weatherByBiome[biomeId] = {
				weather: String(rawWeather.weather ?? "clear"),
				xpBonus: normalizeXpBonus(rawWeather.xpBonus)
			};
		}
		return weatherByBiome;
	}
	function normalizeWeatherResponse(pathname, payload) {
		if (pathname === "/api/game/weather" || pathname === "stream") return normalizeWeatherByBiome(payload);
		const biomeId = normalizeBiomeId$1(String(pathname).match(/^\/api\/game\/weather\/(\d+)$/)?.[1]);
		const weather = payload?.weather && typeof payload.weather === "object" ? payload.weather : payload;
		if (!biomeId || !weather || typeof weather !== "object") return {};
		return { [biomeId]: {
			weather: String(weather.weather ?? "clear"),
			xpBonus: normalizeXpBonus(weather.xpBonus)
		} };
	}
	function getGuildBoosters(payload) {
		return Array.isArray(payload?.boosters) ? payload.boosters : Array.isArray(payload) ? payload : [];
	}
	function getGuildBoosterExpiresAt(booster) {
		const expiresAt = Date.parse(String(booster?.expires_at ?? booster?.expiresAt ?? ""));
		return Number.isFinite(expiresAt) ? expiresAt : null;
	}
	function getNextGuildBoosterExpiration(payload, now = Date.now()) {
		const expirations = getGuildBoosters(payload).map(getGuildBoosterExpiresAt).filter((expiresAt) => expiresAt !== null && expiresAt > now);
		return expirations.length > 0 ? Math.min(...expirations) : null;
	}
	function normalizeGuildBoostersByBiome(payload, now = Date.now()) {
		const guildBoostersByBiome = {};
		for (const booster of getGuildBoosters(payload)) {
			const biomeId = normalizeBiomeId$1(booster?.biome_id ?? booster?.biomeId);
			const guildXpBonus = normalizeXpBonus(booster?.bonus_percent ?? booster?.bonusPercent ?? 50);
			const expiresAt = getGuildBoosterExpiresAt(booster);
			if (!biomeId || guildXpBonus <= 0 || expiresAt !== null && expiresAt <= now) continue;
			guildBoostersByBiome[biomeId] = Math.max(guildBoostersByBiome[biomeId] ?? 0, guildXpBonus);
		}
		return guildBoostersByBiome;
	}
	function normalizeMasteryXpBonusesByBiome(payload) {
		const source = payload?.mastery ?? payload;
		if (!source || typeof source !== "object") return {};
		const masteryEntries = Array.isArray(source) ? source.map((mastery) => [null, mastery]) : Object.entries(source);
		const masteryXpBonusesByBiome = {};
		for (const [rawBiomeId, mastery] of masteryEntries) {
			if (!mastery || typeof mastery !== "object") continue;
			const biomeId = normalizeBiomeId$1(mastery.biomeId ?? mastery.biome_id ?? rawBiomeId);
			const masteryLevel = Math.max(0, Math.floor(normalizeXpBonus(mastery.masteryLevel ?? mastery.mastery_level)));
			const masteryXpBonus = normalizeXpBonus(mastery.xpBonus ?? mastery.xp_bonus ?? masteryLevel * MASTERY_XP_BONUS_PER_LEVEL);
			if (!biomeId || masteryXpBonus <= 0) continue;
			masteryXpBonusesByBiome[biomeId] = Math.max(masteryXpBonusesByBiome[biomeId] ?? 0, masteryXpBonus);
		}
		return masteryXpBonusesByBiome;
	}
	function getBiomeScore(biomeId, xpBonus, biomeWeight, guildXpBonus = 0, masteryXpBonus = 0, includeMasteryXpBonus = true) {
		const normalizedBiomeId = normalizeBiomeId$1(biomeId) ?? 1;
		return normalizeXpBonus(xpBonus) + normalizeXpBonus(guildXpBonus) + (includeMasteryXpBonus ? normalizeXpBonus(masteryXpBonus) : 0) + (normalizedBiomeId - 1) * normalizeXpBonus(biomeWeight);
	}
	function findAvailableBaitForBiome(player, biomeId) {
		const inventory = player?.baitInventory;
		if (!inventory || typeof inventory !== "object") return null;
		const currentGrade = String(player.equippedBait ?? "").match(/^bait_\d+_(low|medium|high|super)$/)?.[1];
		const grades = currentGrade && currentGrade !== "low" ? [currentGrade, "low"] : ["low"];
		for (const grade of grades) {
			const baitId = `bait_${biomeId}_${grade}`;
			if (Number(inventory[baitId]) > 0) return baitId;
		}
		for (const grade of [
			"medium",
			"high",
			"super"
		]) {
			const baitId = `bait_${biomeId}_${grade}`;
			if (Number(inventory[baitId]) > 0) return baitId;
		}
		return null;
	}
	function resolveCompetitionBiomes({ derbyResponse, guildResponse, tournamentResponse, tournamentStandingsResponse }) {
		const activeTournament = tournamentResponse?.active;
		const activeDerby = derbyResponse?.active;
		const guildId = normalizeBiomeId$1(guildResponse?.guild?.guild_id);
		const standings = Array.isArray(tournamentStandingsResponse?.standings) ? tournamentStandingsResponse.standings : [];
		return {
			guildTournamentBiomeId: activeTournament?.is_registered === true || guildId !== null && standings.some((entry) => normalizeBiomeId$1(entry?.guild_id) === guildId) ? normalizeBiomeId$1(activeTournament?.biome_id) : null,
			personalDerbyBiomeId: activeDerby?.is_registered === true ? normalizeBiomeId$1(activeDerby.biome_id) : null
		};
	}
	function selectBestBiome({ biomeWeight, competitionBiomes, dailyQuests = [], guildBoostersByBiome = {}, includeMasteryXpBonus = true, masteryXpBonusesByBiome = {}, maxBiome = 0, now = Date.now(), player, priorityOrder, weatherByBiome }) {
		const decisionOrder = getAutoBiomeDecisionOrder(priorityOrder);
		const usesDailyQuests = decisionOrder.includes(AUTO_BIOME_PRIORITY_IDS.dailyQuest);
		const unlockedBiomes = Array.isArray(player?.unlockedBiomes) ? player.unlockedBiomes : [player?.currentBiome ?? 1];
		const candidates = [];
		for (const rawBiomeId of unlockedBiomes) {
			const biomeId = normalizeBiomeId$1(rawBiomeId);
			const weather = weatherByBiome?.[biomeId];
			if (!biomeId || maxBiome > 0 && biomeId > maxBiome || !weather) continue;
			const dailyQuestMatchCount = usesDailyQuests ? findMatchingDailyQuests({
				biomeId,
				dailyQuests,
				now,
				weather: weather.weather
			}).length : 0;
			const guildXpBonus = normalizeXpBonus(guildBoostersByBiome?.[biomeId]);
			const masteryXpBonus = normalizeXpBonus(masteryXpBonusesByBiome?.[biomeId]);
			const score = getBiomeScore(biomeId, weather.xpBonus, biomeWeight, guildXpBonus, masteryXpBonus, includeMasteryXpBonus);
			candidates.push({
				baitId: findAvailableBaitForBiome(player, biomeId),
				biomeId,
				dailyQuestMatchCount,
				guildXpBonus,
				masteryXpBonus,
				...masteryXpBonus > 0 && !includeMasteryXpBonus ? { masteryXpBonusExcluded: true } : {},
				priorityValues: {
					[AUTO_BIOME_PRIORITY_IDS.guildCompetition]: biomeId === normalizeBiomeId$1(competitionBiomes?.guildTournamentBiomeId) ? 1 : 0,
					[AUTO_BIOME_PRIORITY_IDS.personalCompetition]: biomeId === normalizeBiomeId$1(competitionBiomes?.personalDerbyBiomeId) ? 1 : 0,
					[AUTO_BIOME_PRIORITY_IDS.arcaneSurge]: weather.weather === ARCANE_SURGE_WEATHER ? 1 : 0,
					[AUTO_BIOME_PRIORITY_IDS.goldBreeze]: weather.weather === GOLD_BREEZE_WEATHER ? 1 : 0,
					[AUTO_BIOME_PRIORITY_IDS.dailyQuest]: dailyQuestMatchCount > 0 ? 1 : 0,
					[AUTO_BIOME_PRIORITY_IDS.weightedExperience]: score
				},
				score,
				weather: weather.weather,
				xpBonus: weather.xpBonus
			});
		}
		candidates.sort((left, right) => {
			for (const priorityId of decisionOrder) {
				const difference = right.priorityValues[priorityId] - left.priorityValues[priorityId];
				if (difference !== 0) return difference;
			}
			return right.biomeId - left.biomeId;
		});
		if (candidates.length === 0) return null;
		const { dailyQuestMatchCount, guildXpBonus, masteryXpBonus, priorityValues, ...bestBiome } = candidates[0];
		const selectionPriority = decisionOrder.find((priorityId) => priorityId === AUTO_BIOME_PRIORITY_IDS.weightedExperience || priorityValues[priorityId] > 0) ?? AUTO_BIOME_PRIORITY_IDS.weightedExperience;
		return {
			...bestBiome,
			...guildXpBonus > 0 ? { guildXpBonus } : {},
			...masteryXpBonus > 0 ? { masteryXpBonus } : {},
			selectionPriority,
			...selectionPriority === AUTO_BIOME_PRIORITY_IDS.guildCompetition ? { competitionType: "guild" } : {},
			...selectionPriority === AUTO_BIOME_PRIORITY_IDS.personalCompetition ? { competitionType: "personal" } : {},
			...selectionPriority === AUTO_BIOME_PRIORITY_IDS.dailyQuest ? { dailyQuestCount: dailyQuestMatchCount } : {}
		};
	}
	function getBiomeName(biomeId) {
		return String(unsafeWindow.BIOMES?.[biomeId]?.name ?? "").trim() || `地图 ${biomeId}`;
	}
	function getWeatherLabel(weather) {
		return WEATHER_LABELS[weather] ?? weather ?? "未知天气";
	}
	function formatBiomeTarget(target) {
		return `[B${target.biomeId}] ${getBiomeName(target.biomeId)}`;
	}
	function formatTargetSummary(target) {
		const weatherLabel = getWeatherLabel(target.weather);
		const signedXpBonus = target.xpBonus > 0 ? `+${target.xpBonus}` : String(target.xpBonus);
		const guildXpBonusLabel = target.guildXpBonus > 0 ? ` · 公会 +${target.guildXpBonus}%` : "";
		const masteryXpBonusLabel = target.masteryXpBonus > 0 ? ` · 精通 +${target.masteryXpBonus}%${target.masteryXpBonusExcluded ? "（未计分）" : ""}` : "";
		return `${target.selectionPriority === AUTO_BIOME_PRIORITY_IDS.guildCompetition ? "公会赛优先 · " : target.selectionPriority === AUTO_BIOME_PRIORITY_IDS.personalCompetition ? "个人赛优先 · " : target.selectionPriority === AUTO_BIOME_PRIORITY_IDS.arcaneSurge ? "奥术涌动优先 · " : target.selectionPriority === AUTO_BIOME_PRIORITY_IDS.goldBreeze ? "金风优先 · " : target.selectionPriority === AUTO_BIOME_PRIORITY_IDS.dailyQuest ? "每日任务优先 · " : ""}${formatBiomeTarget(target)} · ${weatherLabel} ${signedXpBonus}%${guildXpBonusLabel}${masteryXpBonusLabel} · 评分 ${target.score}`;
	}
	function getErrorMessage$1(error) {
		return String(error?.message ?? error ?? "未知错误");
	}
	function getPriorityState(priorityOrder) {
		const normalizedPriorityOrder = normalizeAutoBiomePriorityOrder(priorityOrder);
		return {
			dailyQuestEnabled: isAutoBiomePriorityEnabled(normalizedPriorityOrder, AUTO_BIOME_PRIORITY_IDS.dailyQuest),
			goldBreezeEnabled: isAutoBiomePriorityEnabled(normalizedPriorityOrder, AUTO_BIOME_PRIORITY_IDS.goldBreeze),
			guildCompetitionEnabled: isAutoBiomePriorityEnabled(normalizedPriorityOrder, AUTO_BIOME_PRIORITY_IDS.guildCompetition),
			normalizedPriorityOrder,
			personalCompetitionEnabled: isAutoBiomePriorityEnabled(normalizedPriorityOrder, AUTO_BIOME_PRIORITY_IDS.personalCompetition)
		};
	}
	async function autoEquipForBiome(player, target, { skipBait = false, skipRod = false } = {}) {
		const api = unsafeWindow.ApiService;
		if (!skipBait && target.baitId && target.baitId !== player.equippedBait) try {
			await api.equipBait(target.baitId);
		} catch (error) {
			console.warn("[自动换图] 无法自动装备目标地图鱼饵：", error);
		}
		if (skipRod) return;
		const currentRod = String(player.equippedRod ?? "rod_default");
		if (!currentRod.startsWith("rod_biome_") || currentRod === `rod_biome_${target.biomeId}`) return;
		const ownedRods = Array.isArray(player.ownedRods) ? player.ownedRods : [];
		const targetBiomeRod = `rod_biome_${target.biomeId}`;
		const nextRod = ownedRods.includes(targetBiomeRod) ? targetBiomeRod : [
			"rod_strength",
			"rod_luck",
			"rod_relic",
			"rod_treasure",
			"rod_default"
		].find((rodId) => ownedRods.includes(rodId)) ?? "rod_default";
		try {
			await api.equipRod(nextRod);
		} catch (error) {
			console.warn("[自动换图] 无法自动装备可用鱼竿：", error);
		}
	}
	function getNextHourlyRefreshDelay(now = new Date()) {
		return (60 + Math.random() * 60) * 1e3;
	}
	function createAutoBiomeController({ getPlayer, getState, onBiomeReady, onStateChange }) {
		let evaluationId = 0;
		let fallbackTimer = null;
		let competitionHookTimer = null;
		let competitionHookPending = false;
		let derbyResponse;
		let guildBoosterExpiryTimer = null;
		let guildBoosterResponse;
		let guildBoostersByBiome = {};
		let guildResponse;
		let tournamentResponse;
		const tournamentStandingsById = new Map();
		let competitionBiomes = {
			guildTournamentBiomeId: null,
			personalDerbyBiomeId: null
		};
		let competitionStatus = "自动换图开启后检测";
		let competitionUpdatedAt = 0;
		let dailyQuestState = {
			fingerprint: null,
			loadAttempted: false,
			loading: false,
			quests: [],
			status: "自动换图开启后读取",
			updatedAt: 0
		};
		let lastUpdatedAt = 0;
		let masteryLoaded = false;
		let masteryLoadStarted = false;
		let masteryXpBonusesByBiome = {};
		let status = "等待天气数据";
		let switching = false;
		let target = null;
		let weatherByBiome = {};
		let weatherRevision = 0;
		function notifyStateChanged() {
			onStateChange?.();
		}
		function setStatus(nextStatus) {
			status = nextStatus;
			notifyStateChanged();
		}
		function getSnapshot() {
			return {
				autoBiomeCompetitionBiomes: competitionBiomes,
				autoBiomeCompetitionStatus: competitionStatus,
				autoBiomeCompetitionUpdatedAt: competitionUpdatedAt,
				autoBiomeDailyQuestStatus: dailyQuestState.status,
				autoBiomeDailyQuestUpdatedAt: dailyQuestState.updatedAt,
				autoBiomeDailyQuests: dailyQuestState.quests,
				autoBiomeGuildBoostersByBiome: guildBoostersByBiome,
				autoBiomeLastUpdatedAt: lastUpdatedAt,
				autoBiomeMasteryLoaded: masteryLoaded,
				autoBiomeMasteryXpBonusesByBiome: masteryXpBonusesByBiome,
				autoBiomeStatus: status,
				autoBiomeTarget: target,
				autoBiomeWeatherByBiome: weatherByBiome
			};
		}
		function formatCompetitionStatus(biomes, priorityOrder) {
			const { guildCompetitionEnabled, personalCompetitionEnabled } = getPriorityState(priorityOrder);
			const labels = [];
			if (guildCompetitionEnabled && biomes.guildTournamentBiomeId) labels.push(`公会 B${biomes.guildTournamentBiomeId}`);
			if (personalCompetitionEnabled && biomes.personalDerbyBiomeId) labels.push(`个人 B${biomes.personalDerbyBiomeId}`);
			if (!guildCompetitionEnabled && !personalCompetitionEnabled) return "已关闭";
			return labels.length > 0 ? labels.join(" · ") : "暂无已参与的比赛";
		}
		function formatDailyQuestStatus(quests) {
			const labels = quests.filter((quest) => isDailyQuestActive(quest, Date.now())).flatMap((quest) => [...quest.targetBiome ? [`B${quest.targetBiome}`] : [], ...quest.weatherRule ? [getWeatherLabel(quest.weatherRule)] : []]);
			const uniqueLabels = [...new Set(labels)];
			return uniqueLabels.length > 0 ? uniqueLabels.join(" · ") : "暂无需要匹配地图的未完成任务";
		}
		function updateCompetitionState() {
			competitionBiomes = resolveCompetitionBiomes({
				derbyResponse,
				guildResponse,
				tournamentResponse,
				tournamentStandingsResponse: tournamentStandingsById.get(String(tournamentResponse?.active?.id ?? ""))
			});
			competitionStatus = formatCompetitionStatus(competitionBiomes, getState?.()?.autoBiomeSettings?.priorityOrder);
			competitionUpdatedAt = Date.now();
			notifyStateChanged();
		}
		function hasCompetitionSnapshot(priorityOrder) {
			const { guildCompetitionEnabled, personalCompetitionEnabled } = getPriorityState(priorityOrder);
			if (personalCompetitionEnabled && derbyResponse === void 0) return false;
			if (!guildCompetitionEnabled) return true;
			if (tournamentResponse === void 0) return false;
			const activeTournamentId = tournamentResponse?.active?.id;
			if (!activeTournamentId) return true;
			if (tournamentResponse.active.is_registered === true) return true;
			return guildResponse !== void 0 && tournamentStandingsById.has(String(activeTournamentId));
		}
		function scheduleCompetitionEvaluation() {
			competitionHookPending = true;
			window.clearTimeout(competitionHookTimer);
			competitionHookTimer = window.setTimeout(() => {
				competitionHookPending = false;
				evaluateBestBiome();
			}, COMPETITION_HOOK_DEBOUNCE);
		}
		function handleCompetitionResponse({ pathname, payload }) {
			let matched = true;
			if (pathname === "/api/guild/tournaments/current") tournamentResponse = payload;
			else if (pathname === "/api/derby/current") derbyResponse = payload;
			else if (pathname === "/api/guild/my-guild") guildResponse = payload;
			else {
				const standingsMatch = pathname.match(/^\/api\/guild\/tournaments\/([^/]+)\/standings$/);
				if (standingsMatch) tournamentStandingsById.set(standingsMatch[1], payload);
				else matched = false;
			}
			if (!matched) return false;
			updateCompetitionState();
			scheduleCompetitionEvaluation();
			return true;
		}
		function handleGuildBoosterResponse({ pathname, payload }) {
			if (pathname !== "/api/guild/boosters/active") return false;
			guildBoosterResponse = payload;
			updateGuildBoosters();
			return true;
		}
		function updateGuildBoosters() {
			window.clearTimeout(guildBoosterExpiryTimer);
			guildBoostersByBiome = normalizeGuildBoostersByBiome(guildBoosterResponse);
			const nextExpiration = getNextGuildBoosterExpiration(guildBoosterResponse);
			if (nextExpiration !== null) guildBoosterExpiryTimer = window.setTimeout(updateGuildBoosters, Math.max(0, nextExpiration - Date.now()) + 50);
			else guildBoosterExpiryTimer = null;
			notifyStateChanged();
			evaluateBestBiome();
		}
		function applyDailyQuestResponse(payload, source) {
			if (!getDailyQuestSource(payload)) return false;
			if (source === "fetch" && dailyQuestState.loading) return true;
			const quests = normalizeDailyQuests(payload);
			const fingerprint = JSON.stringify(quests);
			const shouldEvaluate = dailyQuestState.loading || fingerprint !== dailyQuestState.fingerprint;
			dailyQuestState = {
				fingerprint,
				loadAttempted: true,
				loading: false,
				quests,
				status: formatDailyQuestStatus(quests),
				updatedAt: Date.now()
			};
			if (shouldEvaluate) {
				notifyStateChanged();
				evaluateBestBiome();
			}
			return true;
		}
		function handleQuestResponse({ pathname, payload, source = "fetch" }) {
			if (pathname !== "/api/quests") return false;
			return applyDailyQuestResponse(payload, source);
		}
		async function notifyBiomeReady(biomeId) {
			try {
				await onBiomeReady?.(biomeId);
			} catch (error) {
				console.warn("[自动换图] 切图后的鱼饵检查失败：", error);
			}
		}
		async function loadAllWeather() {
			if (typeof unsafeWindow.ApiService?.getAllBiomeWeather === "function") return unsafeWindow.ApiService.getAllBiomeWeather();
			const response = await window.fetch("/api/game/weather");
			if (!response.ok) throw new Error(`天气接口返回 ${response.status}`);
			return response.json();
		}
		async function loadDailyQuests() {
			if (typeof unsafeWindow.ApiService?.getQuests === "function") return unsafeWindow.ApiService.getQuests();
			const response = await window.fetch("/api/quests");
			if (!response.ok) throw new Error(`每日任务接口返回 ${response.status}`);
			return response.json();
		}
		async function loadGuildBoosters() {
			if (typeof unsafeWindow.ApiService?.getActiveGuildBoosters === "function") return unsafeWindow.ApiService.getActiveGuildBoosters();
			const response = await window.fetch("/api/guild/boosters/active");
			if (!response.ok) throw new Error(`公会加成接口返回 ${response.status}`);
			return response.json();
		}

		async function loadMasterySnapshot() {
			if (masteryLoadStarted) return;
			masteryLoadStarted = true;
			try {
				let payload = {};
				if (typeof unsafeWindow.ApiService?.request === "function") payload = await unsafeWindow.ApiService.request("/mastery");
				else if (typeof window.fetch === "function") {
					const response = await window.fetch("/api/mastery");
					if (!response.ok) throw new Error(`地图精通接口返回 ${response.status}`);
					payload = await response.json();
				}
				masteryXpBonusesByBiome = normalizeMasteryXpBonusesByBiome(payload);
			} catch (error) {
				console.warn("[自动换图] 无法读取地图精通加成：", error);
				masteryXpBonusesByBiome = {};
			} finally {
				masteryLoaded = true;
				notifyStateChanged();
				evaluateBestBiome();
			}
		}
		function applyWeather(payload, source, { merge = false } = {}) {
			const nextWeather = normalizeWeatherResponse(source === "request" ? "/api/game/weather" : source, payload);
			if (Object.keys(nextWeather).length === 0) return false;
			weatherByBiome = merge ? {
				...weatherByBiome,
				...nextWeather
			} : nextWeather;
			lastUpdatedAt = Date.now();
			if (source !== "request") weatherRevision += 1;
			notifyStateChanged();
			evaluateBestBiome();
			return true;
		}
		function handleWeatherResponse({ pathname, payload, source = "fetch" }) {
			const responsePath = source === "stream" ? "stream" : pathname;
			return applyWeather(payload, responsePath, { merge: responsePath !== "/api/game/weather" && source !== "stream" });
		}
		async function refreshWeather() {
			const revisionBeforeRequest = weatherRevision;
			try {
				const payload = await loadAllWeather();
				if (revisionBeforeRequest === weatherRevision) applyWeather(payload, "request");
			} catch (error) {
				console.warn("[自动换图] 无法读取地图天气：", error);
				if (Object.keys(weatherByBiome).length === 0) setStatus("天气数据读取失败");
			}
		}
		async function refreshGuildBoosters() {
			try {
				const payload = await loadGuildBoosters();
				guildBoosterResponse = payload;
				updateGuildBoosters();
			} catch (error) {
				console.warn("[自动换图] 无法读取公会经验加成：", error);
			}
		}

		async function refreshDailyQuests() {
			if (dailyQuestState.loading) return;
			dailyQuestState = {
				...dailyQuestState,
				loadAttempted: true,
				loading: true,
				status: dailyQuestState.updatedAt > 0 ? "正在更新每日任务" : "正在读取每日任务"
			};
			notifyStateChanged();
			try {
				if (!applyDailyQuestResponse(await loadDailyQuests(), "request")) {
					dailyQuestState = {
						...dailyQuestState,
						loading: false,
						status: dailyQuestState.updatedAt > 0 ? "每日任务响应异常，沿用上次数据" : "每日任务响应异常，按普通地图选择"
					};
					notifyStateChanged();
					evaluateBestBiome();
				}
			} catch (error) {
				console.warn("[自动换图] 无法读取每日任务：", error);
				dailyQuestState = {
					...dailyQuestState,
					loading: false,
					status: dailyQuestState.updatedAt > 0 ? "每日任务更新失败，沿用上次数据" : "每日任务读取失败，按普通地图选择"
				};
				notifyStateChanged();
				evaluateBestBiome();
			}
		}
		function scheduleHourlyFallback() {
			window.clearTimeout(fallbackTimer);
			fallbackTimer = window.setTimeout(async () => {
				const refreshes = [];
				const { autoBiomeSettings = {}, enabled = false } = getState?.() ?? {};
				if (enabled === true && autoBiomeSettings.enabled === true) {
					refreshes.push(refreshWeather());
					refreshes.push(refreshGuildBoosters());
				}
				const { dailyQuestEnabled } = getPriorityState(autoBiomeSettings.priorityOrder);
				if (autoBiomeSettings.enabled === true && dailyQuestEnabled && Date.now() - dailyQuestState.updatedAt > DAILY_QUEST_FALLBACK_FRESHNESS) refreshes.push(refreshDailyQuests());
				await Promise.all(refreshes);
				scheduleHourlyFallback();
			}, getNextHourlyRefreshDelay());
		}
		async function evaluateBestBiome() {
			const currentEvaluationId = ++evaluationId;
			const { autoBaitSettings = {}, autoBiomeSettings = {}, enabled = false } = getState?.() ?? {};
			const { dailyQuestEnabled, goldBreezeEnabled, guildCompetitionEnabled, normalizedPriorityOrder, personalCompetitionEnabled } = getPriorityState(autoBiomeSettings.priorityOrder);
			const competitionEnabled = guildCompetitionEnabled || personalCompetitionEnabled;
			if (!competitionEnabled) competitionStatus = "已关闭";
			else if (competitionUpdatedAt > 0) competitionStatus = formatCompetitionStatus(competitionBiomes, normalizedPriorityOrder);
			else if (competitionStatus === "已关闭") competitionStatus = "自动换图开启后检测";
			if (!dailyQuestEnabled) dailyQuestState.status = "已关闭";
			else if (dailyQuestState.status === "已关闭") dailyQuestState.status = dailyQuestState.updatedAt > 0 ? formatDailyQuestStatus(dailyQuestState.quests) : "自动换图开启后读取";
			if (!autoBiomeSettings.enabled) {
				target = null;
				competitionStatus = competitionEnabled ? "自动换图开启后检测" : "已关闭";
				setStatus("未启用");
				return;
			}
			if (!enabled) {
				target = null;
				competitionStatus = competitionEnabled ? "脚本启动后检测" : "已关闭";
				setStatus("脚本启动后自动选择地图");
				return;
			}
			if (Object.keys(weatherByBiome).length === 0) {
				setStatus("等待天气数据");
				return;
			}
			if (masteryLoadStarted && !masteryLoaded) {
				setStatus("等待地图精通数据");
				return;
			}
			if (switching) return;
			if (competitionEnabled && (!hasCompetitionSnapshot(normalizedPriorityOrder) || competitionHookPending)) {
				competitionStatus = "等待游戏比赛轮询";
				setStatus("等待游戏比赛数据");
				return;
			}
			if (dailyQuestEnabled && dailyQuestState.loading) {
				setStatus("等待每日任务数据");
				return;
			}
			if (dailyQuestEnabled && !dailyQuestState.loadAttempted) {
				setStatus("正在读取每日任务数据");
				refreshDailyQuests();
				return;
			}
			const player = getPlayer?.();
			if (!player) {
				setStatus("等待游戏角色数据");
				return;
			}
			if (currentEvaluationId !== evaluationId) return;
			if (!Object.hasOwn(player, "boat")) {
				target = null;
				setStatus("等待游戏组队状态");
				return;
			}
			if (player?.boat && typeof player.boat.role !== "string") {
				target = null;
				setStatus("等待游戏队长状态");
				return;
			}
			const isBoatLeader = player?.boat?.role === "leader";
			if (player?.boat && !isBoatLeader) {
				target = null;
				setStatus("组队中，等待队长换图");
				await notifyBiomeReady(normalizeBiomeId$1(player.currentBiome));
				return;
			}
			const api = unsafeWindow.ApiService;
			const changeBiome = isBoatLeader ? api?.changeBoatBiome : api?.changeBiome;
			if (typeof changeBiome !== "function") {
				setStatus(isBoatLeader ? "等待游戏组队切图接口" : "等待游戏切图接口");
				return;
			}
			target = selectBestBiome({
				biomeWeight: autoBiomeSettings.biomeWeight,
				competitionBiomes,
				dailyQuests: dailyQuestState.quests,
				guildBoostersByBiome,
				includeMasteryXpBonus: autoBiomeSettings.includeMasteryXpBonus !== false,
				masteryXpBonusesByBiome,
				maxBiome: autoBiomeSettings.maxBiome,
				player,
				priorityOrder: normalizedPriorityOrder,
				weatherByBiome
			});
			const chasingGoldBreeze = goldBreezeEnabled && target?.weather === GOLD_BREEZE_WEATHER;
			if (chasingGoldBreeze) target.baitId = getBaitIdForBiome(target.biomeId, autoBaitSettings?.baitGrade ?? 'low');
			if (!target) {
				setStatus("没有可用的已解锁地图数据");
				await notifyBiomeReady(normalizeBiomeId$1(player.currentBiome));
				return;
			}
			const summary = formatTargetSummary(target);
			if (normalizeBiomeId$1(player.currentBiome) === target.biomeId) {
				if (chasingGoldBreeze && autoBaitSettings?.enabled !== true) await autoEquipForBiome(player, target, { skipRod: true });
				setStatus(`已在 ${summary}`);
				await notifyBiomeReady(target.biomeId);
				return;
			}
			switching = true;
			setStatus(isBoatLeader ? `正在切换整队到 ${summary}` : `正在切换到 ${summary}`);
			try {
				const result = await changeBiome.call(api, target.biomeId);
				if (Array.isArray(result?.blockedBy) && result.blockedBy.length > 0) throw new Error(`队员未解锁目标地图：${result.blockedBy.join("、")}`);
				if (result?.success !== true) throw new Error(result?.message ?? "游戏未确认切图成功");
				await autoEquipForBiome(player, target, { skipBait: autoBaitSettings?.enabled === true });
				setStatus(isBoatLeader ? `已切换整队到 ${summary}，等待下一竿同步页面` : `已切换到 ${summary}，等待下一竿同步页面`);
				await notifyBiomeReady(target.biomeId);
			} catch (error) {
				console.error("[自动换图] 切换地图失败：", error);
				setStatus(`切图失败：${getErrorMessage$1(error)}`);
			} finally {
				switching = false;
			}
		}
		function handleStateChanged() {
			return evaluateBestBiome();
		}
		function handleCastResult(result) {
			const { autoBiomeSettings = {} } = getState?.() ?? {};
			if (Array.isArray(result?.completedQuests) && result.completedQuests.length > 0 && autoBiomeSettings.enabled === true && isAutoBiomePriorityEnabled(autoBiomeSettings.priorityOrder, AUTO_BIOME_PRIORITY_IDS.dailyQuest)) refreshDailyQuests();
			if (target && normalizeBiomeId$1(result?.currentBiome) === target.biomeId) setStatus(`已在 ${formatTargetSummary(target)}`);
		}
		function start() {
			scheduleHourlyFallback();
			loadMasterySnapshot();
			refreshWeather();
			evaluateBestBiome();
		}
		function destroy() {
			window.clearTimeout(fallbackTimer);
			window.clearTimeout(competitionHookTimer);
			window.clearTimeout(guildBoosterExpiryTimer);
		}
		return {
			destroy,
			getSnapshot,
			handleCastResult,
			handleCompetitionResponse,
			handleGuildBoosterResponse,
			handleQuestResponse,
			handleStateChanged,
			handleWeatherResponse,
			isSwitching() {
				return switching;
			},
			refreshWeather,
			refreshDailyQuests,
			start
		};
	}
	var CONFIG = {
		buttonText: "抛竿线",
		buttonPollInterval: 250,
		cooldownButtonText: "冷却时间",
		cooldownReloadDelay: 1e4,
		mouseDownMin: 35,
		mouseDownMax: 90,
		captchaObserveDelayMin: 2200,
		captchaObserveDelayMax: 4200,
		captchaConfirmDelayMin: 1400,
		captchaConfirmDelayMax: 2600,
		autoBossAttackInterval: 6100,
		autoBossPollInterval: 1e4,
		scheduleRandomExtraRatioMin: -.05,
		scheduleRandomExtraRatioMax: .1,
		gameAutoFishingPollInterval: 500,
		gameAutoFishingRetryInterval: 5e3,
		gameAutoFishingStaminaRetryInterval: 6e4
	};
	var STORAGE_KEY = "arcane-angler-cast-enabled-v1";
	var CLICK_DELAY_SETTINGS_STORAGE_KEY = "arcane-angler-click-delay-settings-v1";
	var CAPTCHA_BYPASS_STORAGE_KEY = "arcane-angler-captcha-bypass-enabled-v1";
	var VERIFICATION_HISTORY_STORAGE_KEY = "arcane-angler-verification-history-v1";
	var SCHEDULE_SETTINGS_STORAGE_KEY = "arcane-angler-schedule-settings-v1";
	var SCHEDULE_RUNTIME_STORAGE_KEY = "arcane-angler-schedule-runtime-v1";
	var GAME_AUTO_FISHING_SETTINGS_STORAGE_KEY = "arcane-angler-game-auto-fishing-settings-v1";
	var AUTO_BIOME_SETTINGS_STORAGE_KEY = "arcane-angler-auto-biome-settings-v1";
	var AUTO_BAIT_SETTINGS_STORAGE_KEY = "arcane-angler-auto-bait-settings-v1";
	var AUTO_BOSS_SETTINGS_STORAGE_KEY = "arcane-angler-auto-boss-settings-v1";
	var PANEL_COLLAPSED_STORAGE_KEY = "arcane-angler-panel-collapsed-v1";
	var EARNINGS_STORAGE_KEY = "arcane-angler-earnings-v1";
	var LOGIN_MONITOR_ENABLED_STORAGE_KEY = "arcane-angler-login-monitor-enabled-v1";
	var LOGIN_MONITOR_MACHINE_NAME_STORAGE_KEY = "arcane-angler-login-monitor-machine-name-v1";
	var LOGIN_MONITOR_BOT_KEY_STORAGE_KEY = "arcane-angler-login-monitor-bot-key-v1";
	var LOGIN_MONITOR_USERNAME_STORAGE_KEY = "arcane-angler-login-monitor-username-v1";
	var LOGIN_MONITOR_PASSWORD_STORAGE_KEY = "arcane-angler-login-monitor-password-v1";
	var LOGIN_MONITOR_LOGOUT_NOTIFIED_STORAGE_KEY = "arcane-angler-login-monitor-logout-notified-v1";
	var LOGIN_MONITOR_RARE_DROP_NOTIFY_STORAGE_KEY = "arcane-angler-rare-drop-notify-enabled-v1";
	var PANEL_ID = "arcane-angler-cast-panel-host";
	var STAFF_QUESTION_TEXT = "Staff Question";
	var HUMAN_VERIFICATION_MESSAGE = "Arcane Angler 出现需要处理的验证，自动抛竿已停止";
	var EARNINGS_CATEGORY_DISPLAY = {
		unknown: {
			label: "未知",
			tone: "unknown"
		},
		common: {
			label: "普通",
			tone: "common"
		},
		uncommon: {
			label: "罕见",
			tone: "uncommon"
		},
		fine: {
			label: "精良",
			tone: "fine"
		},
		rare: {
			label: "稀有",
			tone: "rare"
		},
		epic: {
			label: "史诗",
			tone: "epic"
		},
		legendary: {
			label: "传说",
			tone: "legendary"
		},
		mythic: {
			label: "神话",
			tone: "mythic"
		},
		exotic: {
			label: "奇异",
			tone: "exotic"
		},
		arcane: {
			label: "奥术",
			tone: "arcane"
		},
		relic: {
			label: "遗物",
			tone: "relic"
		},
		"treasure chest": {
			label: "宝箱",
			tone: "treasure"
		},
		gears: {
			label: "装备",
			tone: "gear"
		}
	};
	var GEAR_SLOT_DISPLAY = {
		head: "头部",
		torso: "上衣",
		legs: "腿部",
		boots: "鞋子",
		gloves: "手套",
		amulet: "护身符",
		charm: "符咒",
		ring_1: "戒指1",
		ring_2: "戒指2"
	};
	var BOSS_STAT_LABELS = {
		strength: "力量",
		intelligence: "智力",
		luck: "幸运",
		stamina: "耐力"
	};
	var BOSS_STATS = Object.keys(BOSS_STAT_LABELS);
	function normalizeNumber(value) {
		const number = Number(value);
		return Number.isFinite(number) && number > 0 ? number : 0;
	}
	function getStatMultiplier(anomaly, stat) {
		if (stat === anomaly?.primaryWeakness) return 3.75;
		if (stat === anomaly?.secondaryWeakness) return 2;
		if (stat === anomaly?.resistantStat) return .375;
		return 1.125;
	}
	function getPlayerBossStats(player) {
		let totalStats = null;
		try {
			totalStats = unsafeWindow.GameHelpers?.getTotalStats?.(player, null) ?? null;
		} catch (error) {
			console.warn("[自动打 Boss] 无法计算装备后的角色属性：", error);
		}
		const source = totalStats ?? player?.stats ?? player ?? {};
		return Object.fromEntries(BOSS_STATS.map((stat) => [stat, normalizeNumber(source[stat])]));
	}
	function selectBestBossStat(anomaly, stats) {
		const fallback = BOSS_STATS.includes(anomaly?.primaryWeakness) ? anomaly.primaryWeakness : "strength";
		let bestStat = fallback;
		let bestDamage = -1;
		for (const stat of BOSS_STATS) {
			const damage = normalizeNumber(stats?.[stat]) * getStatMultiplier(anomaly, stat);
			if (damage > bestDamage) {
				bestStat = stat;
				bestDamage = damage;
			}
		}
		return bestDamage > 0 ? bestStat : fallback;
	}
	function getErrorMessage(error) {
		return String(error?.message ?? error ?? "未知错误");
	}
	function createAutoBossController({ getPlayer, getState, onStateChange }) {
		let timer = null;
		let checking = false;
		let started = false;
		let status = "未启用";
		let lastAttackAt = 0;
		let lastDamage = 0;
		let lastStat = null;
		let reevaluateAfterCurrent = false;
		let revision = 0;
		function notifyStateChanged() {
			onStateChange?.();
		}
		function setStatus(nextStatus) {
			status = nextStatus;
			notifyStateChanged();
		}
		function schedule(delay) {
			window.clearTimeout(timer);
			timer = null;
			if (!started) return;
			timer = window.setTimeout(() => {
				evaluate().catch((error) => {
					checking = false;
					reevaluateAfterCurrent = false;
					console.error("[自动打 Boss] 未处理的运行异常：", error);
					try {
						setStatus(`运行异常：${getErrorMessage(error)}`);
					} finally {
						schedule(CONFIG.autoBossPollInterval);
					}
				});
			}, delay);
		}
		function getSnapshot() {
			return {
				autoBossChecking: checking,
				autoBossLastAttackAt: lastAttackAt,
				autoBossLastDamage: lastDamage,
				autoBossLastStat: lastStat,
				autoBossStatus: status
			};
		}
		async function evaluate() {
			if (checking) {
				reevaluateAfterCurrent = true;
				return;
			}
			const currentRevision = ++revision;
			const { autoBossSettings, enabled } = getState();
			if (!autoBossSettings.enabled) {
				setStatus("未启用");
				return;
			}
			if (!enabled) {
				setStatus("脚本启动后自动攻击");
				return;
			}
			const api = unsafeWindow.ApiService;
			if (typeof api?.getCurrentAnomaly !== "function" || typeof api?.attackAnomaly !== "function") {
				setStatus("等待游戏 Boss 接口");
				schedule(CONFIG.autoBossPollInterval);
				return;
			}
			checking = true;
			setStatus("正在检查世界 Boss");
			try {
				const current = await api.getCurrentAnomaly();
				const event = current?.event;
				if (currentRevision !== revision || !getState().enabled || !getState().autoBossSettings.enabled) return;
				if (current?.active !== true || !event?.anomaly || normalizeNumber(event.currentHp) === 0) {
					setStatus("暂无活动 Boss");
					schedule(CONFIG.autoBossPollInterval);
					return;
				}
				const lastServerAttackAt = Date.parse(current.playerParticipation?.lastAttackTime ?? "");
				const cooldownRemaining = Number.isFinite(lastServerAttackAt) ? lastServerAttackAt + CONFIG.autoBossAttackInterval - Date.now() : 0;
				if (cooldownRemaining > 0) {
					setStatus(`冷却中，${Math.ceil(cooldownRemaining / 1e3)} 秒后攻击`);
					schedule(cooldownRemaining);
					return;
				}
				const stat = selectBestBossStat(event.anomaly, getPlayerBossStats(getPlayer?.()));
				const statLabel = BOSS_STAT_LABELS[stat];
				setStatus(`正在使用${statLabel}攻击`);
				const result = await api.attackAnomaly(stat);
				if (!result?.attack) throw new Error(result?.message ?? "游戏未返回攻击结果");
				lastAttackAt = Date.now();
				lastDamage = normalizeNumber(result.attack.finalDamage);
				lastStat = stat;
				setStatus(result.anomaly?.defeated ? `已击败 ${result.anomaly.name ?? "世界 Boss"}` : `${statLabel}造成 ${lastDamage.toLocaleString()} 伤害`);
				schedule(CONFIG.autoBossAttackInterval);
			} catch (error) {
				console.error("[自动打 Boss] 攻击失败：", error);
				setStatus(`攻击失败：${getErrorMessage(error)}`);
				schedule(CONFIG.autoBossAttackInterval);
			} finally {
				checking = false;
				if (reevaluateAfterCurrent) {
					reevaluateAfterCurrent = false;
					schedule(0);
				}
			}
		}
		function handleStateChanged() {
			revision += 1;
			window.clearTimeout(timer);
			timer = null;
			if (!started) return;
			const { autoBossSettings, enabled } = getState();
			if (!autoBossSettings.enabled) {
				reevaluateAfterCurrent = false;
				setStatus("未启用");
				return;
			}
			if (!enabled) {
				reevaluateAfterCurrent = false;
				setStatus("脚本启动后自动攻击");
				return;
			}
			if (checking) {
				reevaluateAfterCurrent = true;
				return;
			}
			schedule(0);
		}
		function start() {
			started = true;
			handleStateChanged();
		}
		return {
			checkNow: evaluate,
			getSnapshot,
			handleStateChanged,
			start
		};
	}
	function normalizeText(text) {
		return String(text ?? "").replace(/\s+/g, " ").trim();
	}
	function isVisible(element) {
		if (!(element instanceof HTMLElement)) return false;
		const style = window.getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number.parseFloat(style.opacity || "1") > 0;
	}
	function isDisplayed(element) {
		return isVisible(element) && window.getComputedStyle(element).pointerEvents !== "none";
	}
	function randomInt(min, max) {
		return Math.floor(Math.random() * (max - min + 1)) + min;
	}
	function sleep(milliseconds) {
		return new Promise((resolve) => {
			setTimeout(resolve, milliseconds);
		});
	}
	var ENGLISH_SMALL_NUMBERS = {
		eight: 8,
		eighteen: 18,
		eleven: 11,
		fifteen: 15,
		five: 5,
		four: 4,
		fourteen: 14,
		nine: 9,
		nineteen: 19,
		one: 1,
		seven: 7,
		seventeen: 17,
		six: 6,
		sixteen: 16,
		ten: 10,
		thirteen: 13,
		three: 3,
		twelve: 12,
		two: 2,
		zero: 0
	};
	var ENGLISH_TENS = {
		eighty: 80,
		fifty: 50,
		forty: 40,
		ninety: 90,
		seventy: 70,
		sixty: 60,
		thirty: 30,
		twenty: 20
	};
	function parseEnglishNumber(value) {
		const tokens = String(value ?? "").toLowerCase().replace(/-/g, " ").split(/\s+/).filter((token) => token && token !== "and");
		function parseUnderOneHundred(parts) {
			if (parts.length === 1) return ENGLISH_SMALL_NUMBERS[parts[0]] ?? ENGLISH_TENS[parts[0]];
			if (parts.length === 2 && ENGLISH_TENS[parts[0]] != null && ENGLISH_SMALL_NUMBERS[parts[1]] > 0 && ENGLISH_SMALL_NUMBERS[parts[1]] < 10) return ENGLISH_TENS[parts[0]] + ENGLISH_SMALL_NUMBERS[parts[1]];
		}
		const hundredIndex = tokens.indexOf("hundred");
		if (hundredIndex === -1) return parseUnderOneHundred(tokens);
		if (hundredIndex !== 1 || ENGLISH_SMALL_NUMBERS[tokens[0]] == null || ENGLISH_SMALL_NUMBERS[tokens[0]] < 1 || ENGLISH_SMALL_NUMBERS[tokens[0]] > 9) return;
		const remainder = tokens.slice(2);
		const remainderValue = remainder.length === 0 ? 0 : parseUnderOneHundred(remainder);
		return remainderValue == null ? void 0 : ENGLISH_SMALL_NUMBERS[tokens[0]] * 100 + remainderValue;
	}
	function parseStaffQuestionNumber(value) {
		const number = Number(value);
		return Number.isFinite(number) ? number : parseEnglishNumber(value);
	}
	function readBiomeNumberAnswer(question, currentBiome) {
		if (!/^what biome number are you in now\s*[?？]?$/i.test(normalizeText(question))) return null;
		const biomeNumber = Number(currentBiome);
		return Number.isInteger(biomeNumber) && biomeNumber > 0 ? String(biomeNumber) : null;
	}
	function solveStaffQuestion(question, { currentBiome = null } = {}) {
		const normalizedQuestion = normalizeText(question);
		const biomeNumberAnswer = readBiomeNumberAnswer(normalizedQuestion, currentBiome);
		if (biomeNumberAnswer !== null) return biomeNumberAnswer;
		const match = normalizedQuestion.match(/^(?:how much is|what is|calculate)\s+([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(x|×|\*|\+|-|−|÷|\/|plus|minus|times|multiplied by|divided by)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*\??$/i) ?? normalizedQuestion.match(/^(?:how much is|what is|calculate)\s+(.+?)\s+(plus|minus|times|multiplied by|divided by)\s+(.+?)\s*\??$/i) ?? normalizedQuestion.match(/^(?:请?计算\s*)?([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(x|×|\*|\+|-|−|÷|\/|加|减|乘|乘以|除以)\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:等于多少|是多少|结果是多少)?\s*[?？]?$/i);
		if (!match) return null;
		const left = parseStaffQuestionNumber(match[1]);
		const right = parseStaffQuestionNumber(match[3]);
		const operator = match[2].toLowerCase();
		let result;
		if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
		if ([
			"x",
			"×",
			"*",
			"times",
			"multiplied by",
			"乘",
			"乘以"
		].includes(operator)) result = left * right;
		else if ([
			"+",
			"plus",
			"加"
		].includes(operator)) result = left + right;
		else if ([
			"-",
			"−",
			"minus",
			"减"
		].includes(operator)) result = left - right;
		else if ([
			"/",
			"÷",
			"divided by",
			"除以"
		].includes(operator) && right !== 0) result = left / right;
		else return null;
		if (!Number.isFinite(result)) return null;
		const normalizedResult = Math.round(result * 1e10) / 1e10;
		return String(Object.is(normalizedResult, -0) ? 0 : normalizedResult);
	}
	function collectCaptchaGapCandidates(columnMatches, minimumColumnMatches, minimumRunWidth, maximumRunWidth) {
		const candidates = [];
		let runStart = null;
		for (let x = 0; x <= columnMatches.length; x += 1) {
			const isMatchingColumn = x < columnMatches.length && columnMatches[x] >= minimumColumnMatches;
			if (isMatchingColumn && runStart == null) runStart = x;
			else if (!isMatchingColumn && runStart != null) {
				const runWidth = x - runStart;
				if (runWidth >= minimumRunWidth && runWidth <= maximumRunWidth) candidates.push({
					end: x,
					start: runStart,
					width: runWidth
				});
				runStart = null;
			}
		}
		return candidates;
	}
	function readPixelLuminance(pixels, offset) {
		return pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
	}
	function findCaptchaGapFromPixels(imageData, pieceDimensions) {
		const canvasWidth = Number(imageData?.width);
		const canvasHeight = Number(imageData?.height);
		const pixels = imageData?.data;
		const gapWidth = Math.round(Number(pieceDimensions?.width));
		const gapHeight = Math.round(Number(pieceDimensions?.height));
		if (!Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight) || canvasWidth <= 0 || canvasHeight <= 0 || pixels?.length !== canvasWidth * canvasHeight * 4) throw new Error("验证码背景像素数据无效");
		if (!Number.isInteger(gapWidth) || !Number.isInteger(gapHeight) || gapWidth <= 2 || gapHeight <= 2 || gapWidth >= canvasWidth || gapHeight > canvasHeight) throw new Error("验证码拼图尺寸无效");
		const gapTop = Math.round((canvasHeight - gapHeight) / 2);
		const sampleTop = Math.max(0, gapTop + 1);
		const sampleBottom = Math.min(canvasHeight, gapTop + gapHeight - 1);
		const sampleHeight = sampleBottom - sampleTop;
		const colorCounts = new Map();
		for (let y = sampleTop; y < sampleBottom; y += 1) for (let x = 0; x < canvasWidth; x += 1) {
			const offset = (y * canvasWidth + x) * 4;
			const color = pixels[offset] * 16777216 + pixels[offset + 1] * 65536 + pixels[offset + 2] * 256 + pixels[offset + 3];
			colorCounts.set(color, (colorCounts.get(color) ?? 0) + 1);
		}
		let repeatedColor = null;
		let repeatedColorCount = 0;
		for (const [color, count] of colorCounts) if (count > repeatedColorCount) {
			repeatedColor = color;
			repeatedColorCount = count;
		}
		const columnMatches = new Uint16Array(canvasWidth);
		for (let x = 0; x < canvasWidth; x += 1) for (let y = sampleTop; y < sampleBottom; y += 1) {
			const offset = (y * canvasWidth + x) * 4;
			if (pixels[offset] * 16777216 + pixels[offset + 1] * 65536 + pixels[offset + 2] * 256 + pixels[offset + 3] === repeatedColor) columnMatches[x] += 1;
		}
		const minimumColumnMatches = Math.floor(sampleHeight * .8);
		const minimumRunWidth = Math.floor(gapWidth * .6);
		const maximumRunWidth = Math.ceil(gapWidth * 1.2);
		let candidates = collectCaptchaGapCandidates(columnMatches, minimumColumnMatches, minimumRunWidth, maximumRunWidth);
		if (candidates.length === 0) {
			const darkColumnMatches = new Uint16Array(canvasWidth);
			const lightColumnMatches = new Uint16Array(canvasWidth);
			const rowLuminances = new Float64Array(canvasWidth);
			const minimumContrast = 28;
			for (let y = sampleTop; y < sampleBottom; y += 1) {
				for (let x = 0; x < canvasWidth; x += 1) rowLuminances[x] = readPixelLuminance(pixels, (y * canvasWidth + x) * 4);
				const sortedLuminances = Array.from(rowLuminances).sort((left, right) => left - right);
				const medianLuminance = sortedLuminances[Math.floor(sortedLuminances.length / 2)];
				for (let x = 0; x < canvasWidth; x += 1) {
					const difference = medianLuminance - rowLuminances[x];
					if (difference >= minimumContrast) darkColumnMatches[x] += 1;
					else if (difference <= -28) lightColumnMatches[x] += 1;
				}
			}
			const minimumContrastMatches = Math.floor(sampleHeight * .75);
			candidates = [...collectCaptchaGapCandidates(darkColumnMatches, minimumContrastMatches, minimumRunWidth, maximumRunWidth), ...collectCaptchaGapCandidates(lightColumnMatches, minimumContrastMatches, minimumRunWidth, maximumRunWidth)];
		}
		const gap = candidates.sort((left, right) => Math.abs(left.width - gapWidth) - Math.abs(right.width - gapWidth))[0];
		if (!gap) throw new Error("未找到验证码图片中的缺口");
		const gapX = Math.round((gap.start + gap.end - gapWidth) / 2);
		const travelWidth = canvasWidth - gapWidth;
		if (gapX < 0 || gapX > travelWidth) throw new Error("验证码缺口坐标超出可移动范围");
		return {
			canvasWidth,
			gapX,
			gapWidth,
			ratio: gapX / travelWidth
		};
	}
	function createCaptchaInteraction(rangeValue) {
		const target = Math.round(Number(rangeValue));
		if (!Number.isFinite(target) || target < 0 || target > 100) throw new Error("验证码滑块位置无效");
		const correctionDistance = Math.min(randomInt(2, 6), 100 - target);
		return {
			moveCount: randomInt(8, 16),
			totalDistance: target + correctionDistance * 2
		};
	}
	function createCaptchaController({ getCurrentBiome, getState, notify, onVerificationResult, setEnabled, setNextDelay, setStatus }) {
		let activeCaptchaChallenge = null;
		let activeStaffQuestion = null;
		let captchaBypassAttemptId = 0;
		let captchaBypassInProgress = false;
		function reportVerificationResult(success) {
			try {
				onVerificationResult?.({
					success: Boolean(success),
					timestamp: Date.now()
				});
			} catch (error) {
				console.warn("[自动过验证] 无法记录验证结果：", error);
			}
		}
		function findHumanVerification() {
			const headings = document.querySelectorAll("h1, h2, h3, h4, [role=\"heading\"]");
			for (const heading of headings) if (normalizeText(heading.textContent).includes("人机验证") && isVisible(heading)) return heading;
			return null;
		}
		function findStaffQuestion() {
			const inputs = document.querySelectorAll("input[type=\"text\"][maxlength=\"500\"]");
			for (const input of inputs) {
				if (!isVisible(input)) continue;
				const verification = {
					container: input.parentElement,
					input
				};
				const props = readStaffQuestionProps(verification);
				if (props && (activeStaffQuestion?.id == null || String(props.questionId) === String(activeStaffQuestion.id))) return {
					...verification,
					question: normalizeText(props.question)
				};
			}
			return null;
		}
		function getReactFiber(element) {
			const fiberKey = Object.keys(element ?? {}).find((key) => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
			return fiberKey ? element[fiberKey] : null;
		}
		function closeHumanVerification(verification) {
			let fiber = getReactFiber(verification);
			while (fiber) {
				const props = fiber.memoizedProps;
				if (props?.isOpen === true && typeof props.onClose === "function") {
					props.onClose();
					return true;
				}
				fiber = fiber.return;
			}
			return false;
		}
		function readStaffQuestionProps(verification) {
			for (const element of [verification?.container, verification?.input]) {
				let fiber = getReactFiber(element);
				while (fiber) {
					const props = fiber.memoizedProps;
					if (props?.questionId != null && typeof props.question === "string" && typeof props.onDismiss === "function") return props;
					fiber = fiber.return;
				}
			}
			return null;
		}
		function closeStaffQuestion(verification) {
			const props = readStaffQuestionProps(verification);
			if (!props) return false;
			props.onDismiss();
			return true;
		}
		function syncVisibleStaffQuestion() {
			const verification = findStaffQuestion();
			if (!verification) return null;
			const props = readStaffQuestionProps(verification);
			activeStaffQuestion = {
				...activeStaffQuestion,
				castCountRef: props?.castCountRef ?? activeStaffQuestion?.castCountRef,
				id: props?.questionId ?? activeStaffQuestion?.id ?? null,
				question: props?.question ?? verification.question ?? activeStaffQuestion?.question ?? ""
			};
			return verification;
		}
		async function waitForCaptchaStep(minDelay, maxDelay, status, nextAction, isAttemptActive) {
			const endTime = Date.now() + randomInt(minDelay, maxDelay);
			while (isAttemptActive()) {
				const remaining = endTime - Date.now();
				if (remaining <= 0) return true;
				setStatus(status);
				setNextDelay(`${(remaining / 1e3).toFixed(1)} 秒后${nextAction}`);
				await sleep(Math.min(100, remaining));
			}
			return false;
		}
		async function waitForHumanVerificationToClose(isAttemptActive) {
			const deadline = Date.now() + 1500;
			while (findHumanVerification()) {
				if (!isAttemptActive()) return false;
				if (Date.now() >= deadline) throw new Error("人机验证弹窗关闭超时");
				await sleep(50);
			}
			return true;
		}
		async function waitForStaffQuestionToClose(isAttemptActive) {
			const deadline = Date.now() + 1500;
			while (findStaffQuestion()) {
				if (!isAttemptActive()) return false;
				if (Date.now() >= deadline) throw new Error("Staff Question 弹窗关闭超时");
				await sleep(50);
			}
			return true;
		}
		function parseSvgNumber(value, fieldName) {
			const number = Number.parseFloat(value);
			if (!Number.isFinite(number)) throw new Error(`无法读取验证码的 ${fieldName}`);
			return number;
		}
		function readSvgDimensions(source, fieldName) {
			if (typeof source !== "string" || !source.includes("<svg")) throw new Error(`服务端未返回有效的${fieldName} SVG`);
			const svg = new DOMParser().parseFromString(source, "image/svg+xml");
			if (svg.querySelector("parsererror")) throw new Error(`${fieldName} SVG 解析失败`);
			const root = svg.documentElement;
			const viewBox = root.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
			const width = root.hasAttribute("width") ? parseSvgNumber(root.getAttribute("width"), `${fieldName}宽度`) : viewBox?.[2];
			const height = root.hasAttribute("height") ? parseSvgNumber(root.getAttribute("height"), `${fieldName}高度`) : viewBox?.[3];
			if (!(width > 0) || !(height > 0)) throw new Error(`无法读取${fieldName}尺寸`);
			return {
				height,
				svg,
				width
			};
		}
		function readExposedCaptchaAnswer(source) {
			const { svg } = readSvgDimensions(source, "验证码背景");
			const root = svg.documentElement;
			const gap = Array.from(svg.querySelectorAll("rect")).find((rect) => rect.hasAttribute("stroke-dasharray"));
			if (!gap) throw new Error("未找到验证码缺口标记");
			const viewBox = root.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
			const canvasWidth = viewBox?.length === 4 && Number.isFinite(viewBox[2]) ? viewBox[2] : parseSvgNumber(root.getAttribute("width"), "画布宽度");
			const gapX = parseSvgNumber(gap.getAttribute("x"), "缺口横坐标");
			const gapWidth = parseSvgNumber(gap.getAttribute("width"), "拼图宽度");
			const travelWidth = canvasWidth - gapWidth;
			if (travelWidth <= 0 || gapX < 0 || gapX > travelWidth) throw new Error("验证码缺口坐标超出可移动范围");
			return {
				canvasWidth,
				gapX,
				gapWidth,
				ratio: gapX / travelWidth
			};
		}
		async function readImageCaptchaAnswer(challenge) {
			const piece = readSvgDimensions(challenge.pieceSvg, "验证码拼图");
			const image = await new Promise((resolve, reject) => {
				const element = new Image();
				element.addEventListener("load", () => resolve(element), { once: true });
				element.addEventListener("error", () => reject(new Error("验证码背景图片加载失败")), { once: true });
				element.src = challenge.bgImage;
			});
			const canvas = document.createElement("canvas");
			canvas.width = image.naturalWidth;
			canvas.height = image.naturalHeight;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (!context) throw new Error("浏览器不支持读取验证码背景图片");
			context.drawImage(image, 0, 0);
			return findCaptchaGapFromPixels(context.getImageData(0, 0, canvas.width, canvas.height), piece);
		}
		async function readCaptchaAnswer(challenge) {
			if (typeof challenge?.bgSvg === "string") return readExposedCaptchaAnswer(challenge.bgSvg);
			if (typeof challenge?.bgImage === "string" && typeof challenge?.pieceSvg === "string") return readImageCaptchaAnswer(challenge);
			throw new Error("验证码 challenge 数据不完整");
		}
		async function runCaptchaBypass(challenge, isAttemptActive) {
			const api = unsafeWindow.ApiService;
			if (typeof api?.notifyCaptchaVerified !== "function") throw new Error("页面验证码 API 不可用");
			if (!isAttemptActive()) return false;
			if (!challenge?.token) throw new Error("验证码 challenge 数据不完整");
			const answer = await readCaptchaAnswer(challenge);
			const rangeValue = Math.round(answer.ratio * 100);
			console.warn("[自动过验证] 客户端已暴露验证码答案：", {
				...answer,
				rangeValue
			});
			setStatus("已识别人机验证，正在立即提交");
			setNextDelay("提交验证");
			const interaction = createCaptchaInteraction(rangeValue);
			await api.notifyCaptchaVerified(challenge.token, String(rangeValue), interaction);
			if (activeCaptchaChallenge?.token === challenge.token) activeCaptchaChallenge = null;
			if (!isAttemptActive()) return false;
			const verifiedAt = Date.now();
			const nextInterval = randomInt(9e5, 12e5);
			localStorage.setItem("fishingCaptchaLastVerified", String(verifiedAt));
			localStorage.setItem("fishingCaptchaInterval", String(nextInterval));
			console.warn("[自动过验证] 服务端接受了由客户端题面计算出的答案。");
			if (!await waitForCaptchaStep(CONFIG.captchaConfirmDelayMin, CONFIG.captchaConfirmDelayMax, "验证通过，等待页面确认", "关闭验证弹窗", isAttemptActive)) return false;
			const verification = findHumanVerification();
			if (verification && !closeHumanVerification(verification)) throw new Error("无法关闭人机验证弹窗");
			if (!await waitForHumanVerificationToClose(isAttemptActive)) return false;
			setStatus("人机验证已完成，正在恢复自动抛竿");
			setNextDelay("—");
			return true;
		}
		async function runStaffQuestionBypass(question, isAttemptActive) {
			const api = unsafeWindow.ApiService;
			if (typeof api?.answerToastQuestion !== "function") throw new Error("页面 Staff Question API 不可用");
			const solveQuestion = (targetQuestion) => solveStaffQuestion(targetQuestion?.question, { currentBiome: getCurrentBiome?.() });
			let answer = solveQuestion(question);
			if (answer == null) throw new Error(`无法可靠回答 Staff Question：${question?.question || "未知题目"}`);
			if (!await waitForCaptchaStep(CONFIG.captchaObserveDelayMin, CONFIG.captchaObserveDelayMax, "正在识别 Staff Question", "提交答案", isAttemptActive)) return false;
			const verification = syncVisibleStaffQuestion();
			const latestQuestion = activeStaffQuestion ?? question;
			answer = solveQuestion(latestQuestion);
			if (answer == null) throw new Error(`无法可靠回答 Staff Question：${latestQuestion?.question || "未知题目"}`);
			if (latestQuestion?.id == null) throw new Error("Staff Question 缺少题目 ID");
			const castCount = Number(latestQuestion.castCountRef?.current);
			await api.answerToastQuestion(latestQuestion.id, answer, Number.isFinite(castCount) && castCount >= 0 ? castCount : 0);
			if (String(activeStaffQuestion?.id) === String(latestQuestion.id)) activeStaffQuestion = null;
			console.warn("[自动过验证] Staff Question 已自动回答：", {
				answer,
				question: latestQuestion.question
			});
			if (!await waitForCaptchaStep(CONFIG.captchaConfirmDelayMin, CONFIG.captchaConfirmDelayMax, "答案已提交，等待页面确认", "关闭验证弹窗", isAttemptActive)) return false;
			const visibleQuestion = verification?.container?.isConnected ? verification : findStaffQuestion();
			if (visibleQuestion && !closeStaffQuestion(visibleQuestion)) throw new Error("无法关闭 Staff Question 弹窗");
			if (!await waitForStaffQuestionToClose(isAttemptActive)) return false;
			setStatus("Staff Question 已完成，正在恢复自动抛竿");
			setNextDelay("—");
			return true;
		}
		function cancelCaptchaBypass() {
			captchaBypassAttemptId += 1;
			captchaBypassInProgress = false;
		}
		function stopForHumanVerification() {
			const verificationName = activeStaffQuestion ? STAFF_QUESTION_TEXT : "人机验证";
			setEnabled(false);
			setStatus(`检测到 ${verificationName}，已停止`);
			setNextDelay("请手动完成验证");
			console.warn(`[自动抛竿] 检测到 ${verificationName}，自动操作已停止。`);
			notify();
		}
		async function autoBypassCaptcha(challenge) {
			const { captchaBypassEnabled } = getState();
			if (!captchaBypassEnabled || captchaBypassInProgress) return;
			const attemptId = captchaBypassAttemptId + 1;
			captchaBypassAttemptId = attemptId;
			captchaBypassInProgress = true;
			let bypassSucceeded = false;
			console.warn("[自动抛竿] 捕获到验证码 challenge，尝试自动验证。");
			try {
				bypassSucceeded = await runCaptchaBypass(challenge, () => {
					const state = getState();
					return state.enabled && state.captchaBypassEnabled && attemptId === captchaBypassAttemptId;
				});
				if (bypassSucceeded) reportVerificationResult(true);
			} catch (error) {
				const state = getState();
				if (!state.enabled || !state.captchaBypassEnabled || attemptId !== captchaBypassAttemptId) return;
				if (activeCaptchaChallenge?.token === challenge?.token) activeCaptchaChallenge = null;
				reportVerificationResult(false);
				setEnabled(false);
				setStatus("人机验证绕过失败，已停止");
				setNextDelay("请手动完成验证");
				console.warn("[自动抛竿] 人机验证自动绕过失败：", error);
				notify();
			} finally {
				if (attemptId === captchaBypassAttemptId) captchaBypassInProgress = false;
			}
			const state = getState();
			if (bypassSucceeded && state.enabled && state.captchaBypassEnabled && attemptId === captchaBypassAttemptId) setEnabled(true);
		}
		async function autoBypassStaffQuestion(question) {
			const { captchaBypassEnabled } = getState();
			if (!captchaBypassEnabled || captchaBypassInProgress) return;
			const attemptId = captchaBypassAttemptId + 1;
			captchaBypassAttemptId = attemptId;
			captchaBypassInProgress = true;
			let bypassSucceeded = false;
			console.warn("[自动抛竿] 捕获到 Staff Question，尝试自动回答。");
			try {
				bypassSucceeded = await runStaffQuestionBypass(question, () => {
					const state = getState();
					return state.enabled && state.captchaBypassEnabled && attemptId === captchaBypassAttemptId;
				});
				if (bypassSucceeded) reportVerificationResult(true);
			} catch (error) {
				const state = getState();
				if (!state.enabled || !state.captchaBypassEnabled || attemptId !== captchaBypassAttemptId) return;
				if (String(activeStaffQuestion?.id) === String(question?.id)) activeStaffQuestion = null;
				reportVerificationResult(false);
				setEnabled(false);
				setStatus("Staff Question 自动处理失败，已停止");
				setNextDelay("请手动完成验证");
				console.warn("[自动抛竿] Staff Question 自动处理失败：", error);
				notify();
			} finally {
				if (attemptId === captchaBypassAttemptId) captchaBypassInProgress = false;
			}
			const state = getState();
			if (bypassSucceeded && state.enabled && state.captchaBypassEnabled && attemptId === captchaBypassAttemptId) setEnabled(true);
		}
		function stopIfVerificationFound() {
			syncVisibleStaffQuestion();
			if (activeStaffQuestion) {
				if (getState().captchaBypassEnabled) autoBypassStaffQuestion(activeStaffQuestion);
				else stopForHumanVerification();
				return true;
			}
			if (!activeCaptchaChallenge) return false;
			if (getState().captchaBypassEnabled) autoBypassCaptcha(activeCaptchaChallenge);
			else stopForHumanVerification();
			return true;
		}
		function handleChallenge(challenge) {
			activeCaptchaChallenge = challenge;
			const state = getState();
			if (!state.enabled) return;
			if (state.captchaBypassEnabled) autoBypassCaptcha(challenge);
			else stopForHumanVerification();
		}
		function handleStaffQuestion(question) {
			if (!question) {
				activeStaffQuestion = null;
				return;
			}
			activeStaffQuestion = question;
			const state = getState();
			if (!state.enabled) return;
			if (state.captchaBypassEnabled) autoBypassStaffQuestion(question);
			else stopForHumanVerification();
		}
		function handleBypassSettingChanged() {
			const state = getState();
			if (!state.captchaBypassEnabled) cancelCaptchaBypass();
			if (!state.enabled) return;
			syncVisibleStaffQuestion();
			if (activeStaffQuestion) {
				if (state.captchaBypassEnabled) autoBypassStaffQuestion(activeStaffQuestion);
				else stopForHumanVerification();
				return;
			}
			if (!activeCaptchaChallenge) return;
			if (state.captchaBypassEnabled) autoBypassCaptcha(activeCaptchaChallenge);
			else stopForHumanVerification();
		}
		return {
			cancel: cancelCaptchaBypass,
			clearChallenge() {
				activeCaptchaChallenge = null;
			},
			clearStaffQuestion() {
				activeStaffQuestion = null;
			},
			handleBypassSettingChanged,
			handleChallenge,
			handleStaffQuestion,
			hasActiveVerification() {
				return Boolean(activeCaptchaChallenge || activeStaffQuestion);
			},
			isBypassInProgress() {
				return captchaBypassInProgress;
			},
			stopIfVerificationFound
		};
	}
	var DEFAULT_CLICK_DELAY_SETTINGS = Object.freeze({
		longDelayChancePercent: 8,
		longDelayMaxSeconds: 10,
		longDelayMinSeconds: 5,
		shortDelayMaxSeconds: 2,
		shortDelayMinSeconds: .5
	});
	var MIN_DELAY_SECONDS = .1;
	var MAX_DELAY_SECONDS = 3600;
	function normalizeDelaySeconds(value, fallback) {
		const seconds = Number(value);
		if (!Number.isFinite(seconds)) return fallback;
		return Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, Math.round(seconds * 10) / 10));
	}
	function normalizeChancePercent(value, fallback) {
		const percent = Number(value);
		if (!Number.isFinite(percent)) return fallback;
		return Math.min(100, Math.max(0, Math.round(percent * 10) / 10));
	}
	function normalizeClickDelaySettings(settings, fallback = DEFAULT_CLICK_DELAY_SETTINGS) {
		const shortDelayMinSeconds = normalizeDelaySeconds(settings?.shortDelayMinSeconds, fallback.shortDelayMinSeconds);
		const shortDelayMaxSeconds = normalizeDelaySeconds(settings?.shortDelayMaxSeconds, fallback.shortDelayMaxSeconds);
		const longDelayMinSeconds = normalizeDelaySeconds(settings?.longDelayMinSeconds, fallback.longDelayMinSeconds);
		const longDelayMaxSeconds = normalizeDelaySeconds(settings?.longDelayMaxSeconds, fallback.longDelayMaxSeconds);
		return {
			longDelayChancePercent: normalizeChancePercent(settings?.longDelayChancePercent, fallback.longDelayChancePercent),
			longDelayMaxSeconds: Math.max(longDelayMinSeconds, longDelayMaxSeconds),
			longDelayMinSeconds: Math.min(longDelayMinSeconds, longDelayMaxSeconds),
			shortDelayMaxSeconds: Math.max(shortDelayMinSeconds, shortDelayMaxSeconds),
			shortDelayMinSeconds: Math.min(shortDelayMinSeconds, shortDelayMaxSeconds)
		};
	}
	function secondsToMilliseconds(seconds) {
		return Math.round(seconds * 1e3);
	}
	function getRandomClickDelay(settings, random = Math.random) {
		const normalizedSettings = normalizeClickDelaySettings(settings);
		const isLongDelay = random() < normalizedSettings.longDelayChancePercent / 100;
		const minimum = secondsToMilliseconds(isLongDelay ? normalizedSettings.longDelayMinSeconds : normalizedSettings.shortDelayMinSeconds);
		const maximum = secondsToMilliseconds(isLongDelay ? normalizedSettings.longDelayMaxSeconds : normalizedSettings.shortDelayMaxSeconds);
		return {
			milliseconds: Math.floor(random() * (maximum - minimum + 1)) + minimum,
			isLongDelay
		};
	}
	function isCooldownButton(button, buttonText) {
		const text = normalizeText(button?.textContent);
		return (Boolean(button?.disabled) || button?.getAttribute?.("aria-disabled") === "true") && text.includes(buttonText);
	}
	function createCooldownWatchdog(timeoutMilliseconds) {
		let startedAt = null;
		let timedOut = false;
		return { observe(isCoolingDown, now = Date.now()) {
			if (!isCoolingDown) {
				startedAt = null;
				return false;
			}
			if (timedOut) return false;
			if (startedAt === null) {
				startedAt = now;
				return false;
			}
			if (now - startedAt < timeoutMilliseconds) return false;
			timedOut = true;
			return true;
		} };
	}
	function createFishingActivityWatchdog(now = Date.now()) {
		let lastFishingAt = now;
		let timedOut = false;
		return {
			markFishing(nextNow = Date.now()) {
				lastFishingAt = nextNow;
				timedOut = false;
			},
			observe(timeoutMilliseconds, nextNow = Date.now()) {
				if (timedOut || nextNow - lastFishingAt < timeoutMilliseconds) return false;
				timedOut = true;
				return true;
			}
		};
	}
	function createEmptyEarningsCounters() {
		return {
			casts: 0,
			fish: 0,
			gold: 0,
			fishGold: 0,
			baitCost: 0,
			unknownBaitCostCasts: 0,
			xp: 0,
			relics: 0,
			treasureChests: 0,
			gears: 0,
			rarityCounts: {}
		};
	}
	function createEmptyEarningsStats() {
		return {
			startedAt: Date.now(),
			updatedAt: null,
			...createEmptyEarningsCounters(),
			breakdowns: {},
			lastContext: null
		};
	}
	function toNonNegativeNumber(value) {
		const number = Number(value);
		return Number.isFinite(number) && number > 0 ? number : 0;
	}
	function toNullableNonNegativeNumber(value) {
		if (value === null || value === void 0 || value === "") return null;
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 ? number : null;
	}
	function normalizeRarityCounts(rarityCounts) {
		if (!rarityCounts || typeof rarityCounts !== "object") return {};
		return Object.fromEntries(Object.entries(rarityCounts).map(([category, count]) => [String(category), toNonNegativeNumber(count)]).filter(([, count]) => count > 0));
	}
	function normalizeEarningsCounters(source) {
		return {
			casts: toNonNegativeNumber(source?.casts),
			fish: toNonNegativeNumber(source?.fish),
			gold: toNonNegativeNumber(source?.gold),
			fishGold: toNonNegativeNumber(source?.fishGold),
			baitCost: toNonNegativeNumber(source?.baitCost),
			unknownBaitCostCasts: toNonNegativeNumber(source?.unknownBaitCostCasts),
			xp: toNonNegativeNumber(source?.xp),
			relics: toNonNegativeNumber(source?.relics),
			treasureChests: toNonNegativeNumber(source?.treasureChests),
			gears: toNonNegativeNumber(source?.gears),
			rarityCounts: normalizeRarityCounts(source?.rarityCounts)
		};
	}
	function normalizeDimensionId(value) {
		return String(value ?? "").trim();
	}
	function normalizeEarningsContext(context) {
		if (!context || typeof context !== "object") return null;
		const biomeId = normalizeDimensionId(context.biomeId);
		const baitId = normalizeDimensionId(context.baitId);
		if (!biomeId || !baitId) return null;
		return {
			biomeId,
			biomeName: String(context.biomeName ?? "").trim() || `地图 ${biomeId}`,
			baitId,
			baitName: String(context.baitName ?? "").trim() || baitId,
			baitPrice: toNullableNonNegativeNumber(context.baitPrice)
		};
	}
	function createBreakdownKey(context) {
		return JSON.stringify([context.biomeId, context.baitId]);
	}
	function normalizeBreakdowns(breakdowns) {
		if (!breakdowns || typeof breakdowns !== "object") return {};
		const normalizedBreakdowns = {};
		for (const breakdown of Object.values(breakdowns)) {
			const context = normalizeEarningsContext(breakdown);
			if (!context) continue;
			normalizedBreakdowns[createBreakdownKey(context)] = {
				...context,
				startedAt: toNonNegativeNumber(breakdown.startedAt) || Date.now(),
				updatedAt: toNonNegativeNumber(breakdown.updatedAt) || null,
				...normalizeEarningsCounters(breakdown)
			};
		}
		return normalizedBreakdowns;
	}
	function loadEarningsStats() {
		const emptyStats = createEmptyEarningsStats();
		try {
			const savedStats = JSON.parse(localStorage.getItem(EARNINGS_STORAGE_KEY));
			if (!savedStats || typeof savedStats !== "object") return emptyStats;
			return {
				startedAt: toNonNegativeNumber(savedStats.startedAt) || emptyStats.startedAt,
				updatedAt: toNonNegativeNumber(savedStats.updatedAt) || null,
				...normalizeEarningsCounters(savedStats),
				breakdowns: normalizeBreakdowns(savedStats.breakdowns),
				lastContext: normalizeEarningsContext(savedStats.lastContext)
			};
		} catch (error) {
			console.warn("[收益统计] 无法读取本地统计：", error);
			return emptyStats;
		}
	}
	function saveEarningsStats(earningsStats) {
		try {
			localStorage.setItem(EARNINGS_STORAGE_KEY, JSON.stringify(earningsStats));
		} catch (error) {
			console.warn("[收益统计] 无法保存本地统计：", error);
		}
	}
	function getCastEarnings(result, context) {
		const rarity = String(result.rarity ?? "").trim();
		const count = Math.max(1, toNonNegativeNumber(result.count));
		const isTreasure = Boolean(result.treasureChest) || rarity === "Treasure Chest";
		const isRelic = rarity === "Relic";
		const isGear = rarity === "Gears" && Boolean(result.gear) && !result.inventoryFull;
		const isFish = Boolean(result.fish?.name) && !isTreasure && !isRelic && rarity !== "Gears";
		const baitPrice = toNullableNonNegativeNumber(context?.baitPrice);
		const hasBait = Boolean(context?.baitId);
		const category = isTreasure ? "Treasure Chest" : isRelic ? "Relic" : rarity === "Gears" ? "Gears" : rarity || "Unknown";
		return {
			casts: 1,
			fish: isFish ? count : 0,
			gold: toNonNegativeNumber(result.goldGained),
			fishGold: isFish ? toNonNegativeNumber(result.fish?.baseGold) * count : 0,
			baitCost: baitPrice ?? 0,
			unknownBaitCostCasts: hasBait && baitPrice === null ? 1 : 0,
			xp: toNonNegativeNumber(result.xpGained),
			relics: toNonNegativeNumber(result.relicsGained),
			treasureChests: isTreasure ? 1 : 0,
			gears: isGear ? 1 : 0,
			category,
			earnedCount: isFish ? count : 1
		};
	}
	function incrementEarningsSummary(summary, castEarnings, updatedAt) {
		return {
			...summary,
			updatedAt,
			casts: summary.casts + castEarnings.casts,
			fish: summary.fish + castEarnings.fish,
			gold: summary.gold + castEarnings.gold,
			fishGold: summary.fishGold + castEarnings.fishGold,
			baitCost: summary.baitCost + castEarnings.baitCost,
			unknownBaitCostCasts: summary.unknownBaitCostCasts + castEarnings.unknownBaitCostCasts,
			xp: summary.xp + castEarnings.xp,
			relics: summary.relics + castEarnings.relics,
			treasureChests: summary.treasureChests + castEarnings.treasureChests,
			gears: summary.gears + castEarnings.gears,
			rarityCounts: {
				...summary.rarityCounts,
				[castEarnings.category]: toNonNegativeNumber(summary.rarityCounts[castEarnings.category]) + castEarnings.earnedCount
			}
		};
	}
	function updateEarningsStats(earningsStats, result, context = null) {
		const updatedAt = Date.now();
		const normalizedContext = normalizeEarningsContext(context);
		const castEarnings = getCastEarnings(result, normalizedContext);
		const nextStats = incrementEarningsSummary(earningsStats, castEarnings, updatedAt);
		if (!normalizedContext) return nextStats;
		const key = createBreakdownKey(normalizedContext);
		const nextBreakdown = incrementEarningsSummary({
			...earningsStats.breakdowns?.[key] ?? {
				...normalizedContext,
				startedAt: updatedAt,
				updatedAt: null,
				...createEmptyEarningsCounters()
			},
			...normalizedContext
		}, castEarnings, updatedAt);
		return {
			...nextStats,
			breakdowns: {
				...earningsStats.breakdowns,
				[key]: nextBreakdown
			},
			lastContext: normalizedContext
		};
	}
	function mergeRarityCounts(left, right) {
		const merged = { ...left };
		for (const [category, count] of Object.entries(right)) merged[category] = toNonNegativeNumber(merged[category]) + count;
		return merged;
	}
	function filterEarningsStats(earningsStats, { biomeId = null, baitId = null } = {}) {
		const normalizedBiomeId = biomeId === null ? null : String(biomeId);
		const normalizedBaitId = baitId === null ? null : String(baitId);
		if (normalizedBiomeId === null && normalizedBaitId === null) return earningsStats;
		let filteredStats = {
			startedAt: null,
			updatedAt: null,
			...createEmptyEarningsCounters()
		};
		for (const breakdown of Object.values(earningsStats.breakdowns ?? {})) {
			if (normalizedBiomeId !== null && breakdown.biomeId !== normalizedBiomeId || normalizedBaitId !== null && breakdown.baitId !== normalizedBaitId) continue;
			filteredStats = {
				...filteredStats,
				startedAt: filteredStats.startedAt === null ? breakdown.startedAt : Math.min(filteredStats.startedAt, breakdown.startedAt),
				updatedAt: Math.max(filteredStats.updatedAt ?? 0, breakdown.updatedAt ?? 0),
				casts: filteredStats.casts + breakdown.casts,
				fish: filteredStats.fish + breakdown.fish,
				gold: filteredStats.gold + breakdown.gold,
				fishGold: filteredStats.fishGold + breakdown.fishGold,
				baitCost: filteredStats.baitCost + breakdown.baitCost,
				unknownBaitCostCasts: filteredStats.unknownBaitCostCasts + breakdown.unknownBaitCostCasts,
				xp: filteredStats.xp + breakdown.xp,
				relics: filteredStats.relics + breakdown.relics,
				treasureChests: filteredStats.treasureChests + breakdown.treasureChests,
				gears: filteredStats.gears + breakdown.gears,
				rarityCounts: mergeRarityCounts(filteredStats.rarityCounts, breakdown.rarityCounts)
			};
		}
		return filteredStats;
	}
	function listEarningsBreakdowns(earningsStats) {
		return Object.values(earningsStats.breakdowns ?? {});
	}
	var cachedBaits = null;
	var cachedBaitCatalog = new Map();
	function normalizeId(value, fallback) {
		return String(value ?? "").trim() || fallback;
	}
	function getBaitCatalog() {
		const baits = Array.isArray(unsafeWindow.BAITS) ? unsafeWindow.BAITS : [];
		if (baits !== cachedBaits) {
			cachedBaits = baits;
			cachedBaitCatalog = new Map(baits.filter((bait) => bait?.id).map((bait) => [String(bait.id), bait]));
		}
		return cachedBaitCatalog;
	}
	function getBaitById(baitId) {
		if (typeof unsafeWindow.getBaitById === "function") try {
			const bait = unsafeWindow.getBaitById(baitId);
			if (bait) return bait;
		} catch (error) {
			console.warn("[收益统计] 无法从页面查询鱼饵信息：", error);
		}
		return getBaitCatalog().get(baitId) ?? null;
	}
	function normalizeBaitPrice(value) {
		const price = Number(value);
		return Number.isFinite(price) && price >= 0 ? price : null;
	}
	function getCastEarningsContext(result) {
		const biomeId = normalizeId(result.currentBiome, "unknown");
		const baitId = normalizeId(result.equippedBait, "unknown");
		const biome = unsafeWindow.BIOMES?.[biomeId] ?? null;
		const bait = getBaitById(baitId);
		return {
			biomeId,
			biomeName: String(biome?.name ?? "").trim() || `地图 ${biomeId}`,
			baitId,
			baitName: String(bait?.name ?? "").trim() || baitId,
			baitPrice: normalizeBaitPrice(bait?.price)
		};
	}
	function findGameAutoFishingButton(root = document) {
		const buttons = root.querySelectorAll("button");
		for (const button of buttons) {
			if (!isDisplayed(button)) continue;
			const hasKnownLayout = button.classList.contains("flex-[15]");
			const title = normalizeText(button.getAttribute("title"));
			const hasKnownAction = /(?:start|stop)\s+auto[- ]cast/i.test(title) || /(?:开始|停止).*自动(?:抛竿|钓鱼)/.test(title);
			if (hasKnownLayout || hasKnownAction) return button;
		}
		return null;
	}
	function isGameAutoFishingActive(button) {
		if (!button) return false;
		const title = normalizeText(button.getAttribute("title"));
		if (/stop\s+auto[- ]cast/i.test(title) || /停止.*自动(?:抛竿|钓鱼)/.test(title)) return true;
		const statusPanel = button.parentElement?.nextElementSibling;
		if (button.classList.contains("bg-red-600") || statusPanel?.classList.contains("border-purple-500")) return true;
		if (/start\s+auto[- ]cast/i.test(title) || /开始.*自动(?:抛竿|钓鱼)/.test(title) || /cooldown|冷却/i.test(title)) return false;
		if (button.classList.contains("bg-purple-600") || button.classList.contains("bg-gray-600")) return false;
		return normalizeText(button.textContent).includes("🛑");
	}
	function getGameAutoFishingState(root = document) {
		const button = findGameAutoFishingButton(root);
		if (!button) return {
			active: false,
			available: false,
			button: null,
			enabled: false
		};
		return {
			active: isGameAutoFishingActive(button),
			available: true,
			button,
			enabled: !button.disabled && button.getAttribute("aria-disabled") !== "true"
		};
	}
	function dismissGameAutoFishingSummary(root = document) {
		const headings = root.querySelectorAll("h1, h2, h3");
		for (const heading of headings) {
			const text = normalizeText(heading.textContent);
			if (!/auto[- ]cast\s+summary/i.test(text) && !/自动(?:抛竿|钓鱼)(?:汇总|摘要)/.test(text)) continue;
			let overlay = heading.parentElement;
			while (overlay && !overlay.classList.contains("fixed")) overlay = overlay.parentElement;
			if (!overlay) continue;
			const buttons = overlay.querySelectorAll("button");
			for (const button of buttons) if (isDisplayed(button)) {
				button.click();
				return true;
			}
		}
		return false;
	}
	function dismissGameAutoFishingCompletion(root = document) {
		const overlays = root.querySelectorAll("div.fixed.inset-0");
		for (const overlay of overlays) {
			const text = normalizeText(overlay.textContent);
			if (!(/auto-cast complete\s*:\s*all stamina consumed!?/i.test(text) || /自动(?:抛竿|钓鱼)完成\s*[：:]\s*体力已耗尽[！!]?/.test(text))) continue;
			const buttons = overlay.querySelectorAll("button");
			for (const button of buttons) {
				const buttonText = normalizeText(button.textContent);
				if (isDisplayed(button) && /^(?:ok|确定)$/i.test(buttonText)) {
					button.click();
					return true;
				}
			}
		}
		return false;
	}
	function createGameAutoFishingController({ now = Date.now, onStateChange, prepareStart, retryInterval = CONFIG.gameAutoFishingRetryInterval, staminaRetryInterval = CONFIG.gameAutoFishingStaminaRetryInterval, shouldStart = () => true } = {}) {
		let mayBeActive = false;
		let preparationRequired = true;
		let startPendingUntil = 0;
		let staminaRetryUntil = 0;
		let status = "未启用";
		let wasActive = false;
		function setStatus(nextStatus) {
			if (status === nextStatus) return;
			status = nextStatus;
			onStateChange?.();
		}
		function observe() {
			const state = getGameAutoFishingState();
			if (state.active) {
				mayBeActive = true;
				preparationRequired = false;
				startPendingUntil = 0;
				wasActive = true;
			} else if (state.available && now() >= startPendingUntil) {
				if (wasActive) preparationRequired = true;
				mayBeActive = false;
				wasActive = false;
			}
			return state;
		}
		async function ensureActive() {
			if (dismissGameAutoFishingCompletion()) {
				mayBeActive = false;
				preparationRequired = true;
				startPendingUntil = 0;
				staminaRetryUntil = now() + staminaRetryInterval;
				wasActive = false;
				setStatus("体力已耗尽，稍后自动续期");
				return {
					...getGameAutoFishingState(),
					active: false,
					staminaExhausted: true
				};
			}
			dismissGameAutoFishingSummary();
			let state = observe();
			if (now() < staminaRetryUntil) {
				setStatus("体力已耗尽，稍后自动续期");
				return {
					...state,
					active: false,
					staminaExhausted: true
				};
			}
			staminaRetryUntil = 0;
			if (state.active) {
				setStatus("运行中，次数结束后自动续期");
				return state;
			}
			if (!state.available) {
				setStatus("等待游戏内置自动钓鱼按钮");
				return state;
			}
			if (now() < startPendingUntil) {
				setStatus("正在启动");
				return state;
			}
			if (!state.enabled) {
				setStatus("等待体力或按钮冷却");
				return state;
			}
			if (!shouldStart()) {
				setStatus("已取消启动");
				return state;
			}
			if (preparationRequired) {
				setStatus("正在准备内置自动钓鱼鱼饵");
				if (await prepareStart?.() === false) {
					setStatus("等待内置自动钓鱼鱼饵可用");
					return observe();
				}
				preparationRequired = false;
				state = observe();
				if (state.active) {
					setStatus("运行中，次数结束后自动续期");
					return state;
				}
				if (!state.available || !state.enabled || !shouldStart()) {
					setStatus(!state.available ? "等待游戏内置自动钓鱼按钮" : !state.enabled ? "等待体力或按钮冷却" : "已取消启动");
					return state;
				}
			}
			startPendingUntil = now() + retryInterval;
			mayBeActive = true;
			state.button.click();
			const nextState = observe();
			setStatus(nextState.active ? "运行中，次数结束后自动续期" : "正在启动");
			return nextState;
		}
		function ensureStopped() {
			const state = observe();
			if (!state.active) {
				if (now() < startPendingUntil) {
					setStatus("等待启动操作完成后停止");
					return false;
				}
				if (!state.available && mayBeActive) {
					setStatus("等待返回钓鱼页面后停止");
					return false;
				}
				dismissGameAutoFishingSummary();
				dismissGameAutoFishingCompletion();
				mayBeActive = false;
				staminaRetryUntil = 0;
				setStatus("已停止");
				return true;
			}
			if (!state.enabled) {
				setStatus("等待按钮冷却后停止");
				return false;
			}
			startPendingUntil = 0;
			state.button.click();
			setStatus("正在停止");
			return false;
		}
		return {
			ensureActive,
			ensureStopped,
			getSnapshot() {
				return {
					gameAutoFishingMayBeActive: mayBeActive,
					gameAutoFishingStatus: status
				};
			},
			observe
		};
	}
	function isObject(value) {
		return Boolean(value) && typeof value === "object" && !Array.isArray(value);
	}
	function normalizeBiomeId(value) {
		const biomeId = Number(value);
		return Number.isInteger(biomeId) && biomeId > 0 ? biomeId : null;
	}
	function normalizeQuantity(value) {
		const quantity = Number(value);
		return Number.isFinite(quantity) && quantity >= 0 ? Math.floor(quantity) : null;
	}
	function isSuccessful(payload) {
		return payload?.success !== false;
	}
	function createGameStateStore() {
		let player = null;
		let updatedAt = 0;
		function replacePlayer(nextPlayer) {
			if (!isObject(nextPlayer)) return false;
			player = player?.boat !== void 0 && !Object.hasOwn(nextPlayer, "boat") ? {
				...nextPlayer,
				boat: player.boat
			} : nextPlayer;
			updatedAt = Date.now();
			return true;
		}
		function mergePlayer(patch) {
			if (!player || !isObject(patch)) return false;
			player = {
				...player,
				...patch
			};
			updatedAt = Date.now();
			return true;
		}
		function updateBaitInventory(baitId, quantity) {
			const normalizedQuantity = normalizeQuantity(quantity);
			if (!player || !baitId || normalizedQuantity === null) return false;
			return mergePlayer({ baitInventory: {
				...player.baitInventory,
				[baitId]: normalizedQuantity
			} });
		}
		function handleCastResult(result) {
			if (!player || !isObject(result)) return false;
			const patch = {};
			const biomeId = normalizeBiomeId(result.currentBiome);
			if (biomeId) patch.currentBiome = biomeId;
			if (result.equippedBait) {
				patch.equippedBait = result.equippedBait;
				const quantity = normalizeQuantity(result.baitQuantity);
				if (quantity !== null) patch.baitInventory = {
					...player.baitInventory,
					[result.equippedBait]: quantity
				};
			}
			for (const [sourceField, targetField] of Object.entries({
				newGold: "gold",
				newLevel: "level",
				newStamina: "stamina",
				newStatPoints: "statPoints",
				newXP: "xp",
				newXpToNext: "xpToNext"
			})) if (result[sourceField] !== void 0) patch[targetField] = result[sourceField];
			return mergePlayer(patch);
		}
		function handleResponse({ method, pathname, payload, requestPayload }) {
			if (method === "GET" && pathname === "/api/player/data") return {
				changed: replacePlayer(payload),
				shouldEvaluate: true
			};
			if (method === "GET" && pathname === "/api/boats/my-boat") return {
				changed: mergePlayer({ boat: payload?.boat ?? null }),
				shouldEvaluate: true
			};
			if (method !== "POST" || !isSuccessful(payload)) return {
				changed: false,
				shouldEvaluate: false
			};
			if (pathname === "/api/game/cast" || pathname === "/api/game/auto-cast") return {
				changed: handleCastResult(payload?.result ?? payload),
				shouldEvaluate: false
			};
			if (pathname === "/api/game/change-biome" || pathname === "/api/boats/change-biome") {
				const biomeId = normalizeBiomeId(requestPayload?.biomeId);
				const patch = biomeId ? { currentBiome: biomeId } : null;
				if (patch && pathname === "/api/boats/change-biome" && player?.boat) patch.boat = {
					...player.boat,
					biome: biomeId
				};
				return {
					changed: patch ? mergePlayer(patch) : false,
					shouldEvaluate: false
				};
			}
			if (pathname === "/api/game/equip-bait") return {
				changed: requestPayload?.baitName ? mergePlayer({ equippedBait: requestPayload.baitName }) : false,
				shouldEvaluate: false
			};
			if (pathname === "/api/game/equip-rod") return {
				changed: requestPayload?.rodName ? mergePlayer({ equippedRod: requestPayload.rodName }) : false,
				shouldEvaluate: false
			};
			if (pathname === "/api/game/buy-bait") {
				const baitId = requestPayload?.baitName;
				const responseQuantity = normalizeQuantity(payload?.newBaitQuantity);
				const currentQuantity = normalizeQuantity(player?.baitInventory?.[baitId]);
				const purchasedQuantity = normalizeQuantity(requestPayload?.quantity);
				let changed = updateBaitInventory(baitId, responseQuantity ?? (currentQuantity !== null && purchasedQuantity !== null ? currentQuantity + purchasedQuantity : null));
				if (payload?.newGold !== void 0) changed = mergePlayer({ gold: payload.newGold }) || changed;
				return {
					changed,
					shouldEvaluate: false
				};
			}
			return {
				changed: false,
				shouldEvaluate: false
			};
		}
		return {
			getPlayerSnapshot() {
				return player;
			},
			getUpdatedAt() {
				return updatedAt;
			},
			handleResponse
		};
	}
	function isWeatherStreamUrl(url) {
		try {
			return new URL(String(url), window.location.href).pathname === "/api/game/weather/stream";
		} catch {
			return false;
		}
	}
	function installEventSourceInterceptor({ onWeatherUpdate } = {}) {
		const OriginalEventSource = unsafeWindow.EventSource;
		if (typeof OriginalEventSource !== "function") return false;
		unsafeWindow.EventSource = new Proxy(OriginalEventSource, { construct(Target, args) {
			const source = Reflect.construct(Target, args);
			if (isWeatherStreamUrl(args[0]) && typeof source.addEventListener === "function") source.addEventListener("message", (event) => {
				try {
					const payload = JSON.parse(event.data);
					if (payload?.type === "weather_update") onWeatherUpdate?.(payload);
				} catch (error) {
					console.warn("[自动换图] 无法解析游戏天气推送：", error);
				}
			});
			return source;
		} });
		return true;
	}
	function installFetchInterceptor({ onCaptchaChallenge, onCaptchaVerified, onCastResult, onCompetitionResponse, onGameStateResponse, onGuildBoosterResponse, onQuestResponse, onStaffQuestion, onStaffQuestionResolved, onWeatherResponse }) {
		const originalFetch = unsafeWindow.fetch;
		unsafeWindow.fetch = async function(input, init) {
			const request = input instanceof Request ? input : null;
			const method = String(init?.method ?? request?.method ?? "GET").toUpperCase();
			let url = null;
			try {
				url = new URL(request?.url ?? String(input), window.location.href);
			} catch {}
			const requestPayloadPromise = method === "POST" && isGameStateResponsePath(method, url?.pathname) && !isCastResultResponsePath(method, url?.pathname) ? readRequestPayload(request, init).catch((error) => {
				console.warn("[游戏状态] 无法读取请求参数：", error);
			}) : Promise.resolve(void 0);
			if (method === "POST" && url?.pathname === "/api/game/cast") {
				const modifiedRequest = await modifyCastRequest(input, request, init);
				const response = modifiedRequest ? await originalFetch.call(this, modifiedRequest.input, modifiedRequest.init) : await originalFetch.apply(this, arguments);
				try {
					collectCastResponse(response.clone(), url.pathname, onCastResult, onGameStateResponse);
				} catch (error) {
					console.warn("[收益统计] 无法复制抛竿响应：", error);
				}
				return response;
			}
			if (method === "POST" && url?.pathname === "/api/game/auto-cast") {
				const response = await originalFetch.apply(this, arguments);
				try {
					collectCastResponse(response.clone(), url.pathname, onCastResult, onGameStateResponse);
				} catch (error) {
					console.warn("[收益统计] 无法复制内置自动钓鱼响应：", error);
				}
				return response;
			}
			const response = await originalFetch.apply(this, arguments);
			if (method === "GET" && url?.pathname === "/api/game/captcha-challenge") try {
				collectCaptchaChallengeResponse(response.clone(), onCaptchaChallenge);
			} catch (error) {
				console.warn("[自动过验证] 无法复制验证码 challenge 响应：", error);
			}
			else if (method === "POST" && url?.pathname === "/api/game/captcha-verified" && response.ok) onCaptchaVerified();
			else if (method === "GET" && url?.pathname === "/api/moderation/pending-toast-question") try {
				collectStaffQuestionResponse(response.clone(), onStaffQuestion);
			} catch (error) {
				console.warn("[自动过验证] 无法复制 Staff Question 响应：", error);
			}
			else if (isStaffQuestionResolutionPath(method, url?.pathname) && response.ok) onStaffQuestionResolved?.();
			else if (method === "GET" && isCompetitionResponsePath(url?.pathname)) try {
				collectCompetitionResponse(response.clone(), url.pathname, onCompetitionResponse);
			} catch (error) {
				console.warn("[自动换图] 无法复制游戏比赛轮询响应：", error);
			}
			else if (method === "GET" && isGuildBoosterResponsePath(url?.pathname)) try {
				collectJsonResponse(response.clone(), {
					method,
					pathname: url.pathname
				}, onGuildBoosterResponse, "[自动换图] 无法读取公会经验加成响应：");
			} catch (error) {
				console.warn("[自动换图] 无法复制公会经验加成响应：", error);
			}
			if (method === "GET" && isWeatherResponsePath(url?.pathname)) try {
				collectJsonResponse(response.clone(), {
					method,
					pathname: url.pathname
				}, onWeatherResponse, "[自动换图] 无法读取游戏天气响应：");
			} catch (error) {
				console.warn("[自动换图] 无法复制游戏天气响应：", error);
			}
			if (method === "GET" && isQuestResponsePath(url?.pathname)) try {
				collectJsonResponse(response.clone(), {
					method,
					pathname: url.pathname
				}, onQuestResponse, "[自动换图] 无法读取游戏每日任务响应：");
			} catch (error) {
				console.warn("[自动换图] 无法复制游戏每日任务响应：", error);
			}
			if (isGameStateResponsePath(method, url?.pathname)) try {
				collectGameStateResponse(response.clone(), {
					method,
					pathname: url.pathname,
					requestPayloadPromise
				}, onGameStateResponse);
			} catch (error) {
				console.warn("[游戏状态] 无法复制游戏状态响应：", error);
			}
			return response;
		};
	}
	function isGameStateResponsePath(method, pathname) {
		if (method === "GET") return pathname === "/api/player/data" || pathname === "/api/boats/my-boat";
		return method === "POST" && [
			"/api/game/cast",
			"/api/game/auto-cast",
			"/api/game/buy-bait",
			"/api/game/change-biome",
			"/api/game/equip-bait",
			"/api/game/equip-rod",
			"/api/boats/change-biome"
		].includes(pathname);
	}
	function isCastResultResponsePath(method, pathname) {
		return method === "POST" && (pathname === "/api/game/cast" || pathname === "/api/game/auto-cast");
	}
	function isWeatherResponsePath(pathname) {
		return pathname === "/api/game/weather" || /^\/api\/game\/weather\/\d+$/.test(pathname ?? "");
	}
	function isQuestResponsePath(pathname) {
		return pathname === "/api/quests";
	}
	function isGuildBoosterResponsePath(pathname) {
		return pathname === "/api/guild/boosters/active";
	}
	function isStaffQuestionResolutionPath(method, pathname) {
		return method === "POST" && /^\/api\/moderation\/(?:answer|dismiss)-toast-question\/[^/]+$/.test(pathname ?? "");
	}
	function isCompetitionResponsePath(pathname) {
		return pathname === "/api/guild/tournaments/current" || pathname === "/api/derby/current" || pathname === "/api/guild/my-guild" || /^\/api\/guild\/tournaments\/[^/]+\/standings$/.test(pathname ?? "");
	}
	async function modifyCastRequest(input, request, init) {
		try {
			let body = init?.body;
			if (body === void 0 && request) body = await request.clone().text();
			const originalPayload = await normalizeRequestBody(body);
			if (!originalPayload || typeof originalPayload !== "object" || Array.isArray(originalPayload)) throw new TypeError("payload 不是可修改的对象");
			const payload = {
				...originalPayload,
				isTrusted: true
			};
			console.info("[自动抛竿] POST /api/game/cast payload:", payload);
			const modifiedBody = JSON.stringify(payload);
			if (init?.body !== void 0 || !request) return {
				input,
				init: {
					...init,
					body: modifiedBody
				}
			};
			return {
				input: new Request(request, { body: modifiedBody }),
				init
			};
		} catch (error) {
			console.warn("[自动抛竿] 无法修改 POST /api/game/cast payload，保留原请求：", error);
			return null;
		}
	}
	async function normalizeRequestBody(body) {
		if (body == null) return body;
		if (typeof body === "string") try {
			return JSON.parse(body);
		} catch {
			return body;
		}
		if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
		if (body instanceof FormData) return Object.fromEntries(body.entries());
		if (body instanceof Blob) return normalizeRequestBody(await body.text());
		return body;
	}
	async function readRequestPayload(request, init) {
		let body = init?.body;
		if (body === void 0 && request) body = await request.clone().text();
		return normalizeRequestBody(body);
	}
	async function collectStaffQuestionResponse(response, onStaffQuestion) {
		if (!response.ok || typeof onStaffQuestion !== "function") return;
		try {
			const pending = (await response.json())?.pending;
			onStaffQuestion(pending?.id != null && typeof pending.question === "string" ? pending : null);
		} catch (error) {
			console.warn("[自动过验证] 无法读取 Staff Question 响应：", error);
		}
	}
	async function collectCastResponse(response, pathname, onCastResult, onGameStateResponse) {
		if (!response.ok) return;
		try {
			const payload = await response.json();
			const result = payload?.result ?? payload;
			if (payload?.success !== true || !result || typeof result !== "object") return;
			onGameStateResponse?.({
				method: "POST",
				pathname,
				payload
			});
			onCastResult?.(result, { pathname });
		} catch (error) {
			console.warn("[收益统计] 无法读取抛竿响应：", error);
		}
	}
	async function collectCaptchaChallengeResponse(response, onCaptchaChallenge) {
		if (!response.ok) return;
		try {
			const payload = await response.json();
			const challenge = payload?.result ?? payload;
			const hasLegacySvg = typeof challenge?.bgSvg === "string";
			const hasImagePuzzle = typeof challenge?.bgImage === "string" && typeof challenge?.pieceSvg === "string";
			if (!challenge?.token || !hasLegacySvg && !hasImagePuzzle) return;
			onCaptchaChallenge(challenge);
		} catch (error) {
			console.warn("[自动过验证] 无法读取验证码 challenge 响应：", error);
		}
	}
	async function collectCompetitionResponse(response, pathname, callback) {
		if (!response.ok || typeof callback !== "function") return;
		try {
			callback({
				pathname,
				payload: await response.json()
			});
		} catch (error) {
			console.warn("[自动换图] 无法读取游戏比赛轮询响应：", error);
		}
	}
	async function collectJsonResponse(response, context, callback, warning) {
		if (!response.ok || typeof callback !== "function") return;
		try {
			const payload = await response.json();
			callback({
				...context,
				payload
			});
		} catch (error) {
			console.warn(warning, error);
		}
	}
	async function collectGameStateResponse(response, context, callback) {
		if (!response.ok || typeof callback !== "function") return;
		try {
			const [payload, requestPayload] = await Promise.all([response.json(), context.requestPayloadPromise]);
			callback({
				method: context.method,
				pathname: context.pathname,
				payload,
				requestPayload
			});
		} catch (error) {
			console.warn("[游戏状态] 无法读取游戏状态响应：", error);
		}
	}
	function sendWeChatHumanVerificationNotification() {
		const botKey = loginMonitorSettings.botKey;
		if (!botKey) {
			console.info("[自动抛竿] 未配置微信机器人 Key，跳过验证通知。");
			return;
		}
		sendWxBot(botKey, formatBotMessage(`⚠️ ${HUMAN_VERIFICATION_MESSAGE}`));
	}
	function formatScheduleDuration(milliseconds) {
		const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1e3));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes === 0) return `${seconds} 秒`;
		return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
	}
	function createScheduleController({ getCaptcha, getState, initialRuntime, now = Date.now, onRestTick, onRuntimeChange, onWorkStarted, prepareForWork, renderSettings, renderStatus, setNextDelay, setStatus, sleepFor = sleep }) {
		let phase = initialRuntime?.schedulePhase === "rest" ? "rest" : "work";
		let endsAt = Number(initialRuntime?.scheduleEndsAt) || 0;
		let duration = Number(initialRuntime?.scheduleDuration) || 0;
		if (endsAt <= 0 || duration <= 0) {
			phase = "work";
			endsAt = 0;
			duration = 0;
		}
		function getSnapshot() {
			return {
				scheduleDuration: duration,
				scheduleEndsAt: endsAt,
				schedulePhase: phase
			};
		}
		function persistRuntime() {
			onRuntimeChange?.(getSnapshot());
		}
		function getRandomizedDuration(baseMinutes) {
			const extraRatio = CONFIG.scheduleRandomExtraRatioMin + Math.random() * (CONFIG.scheduleRandomExtraRatioMax - CONFIG.scheduleRandomExtraRatioMin);
			return Math.round(baseMinutes * (1 + extraRatio) * 6e4);
		}
		function reset() {
			phase = "work";
			endsAt = 0;
			duration = 0;
			persistRuntime();
			renderSettings();
		}
		function startPhase(nextPhase) {
			const { scheduleSettings } = getState();
			const baseMinutes = nextPhase === "rest" ? scheduleSettings.restMinutes : scheduleSettings.workMinutes;
			phase = nextPhase;
			duration = getRandomizedDuration(baseMinutes);
			endsAt = now() + duration;
			persistRuntime();
			renderSettings();
			if (nextPhase === "work") onWorkStarted?.();
			console.info(`[自动抛竿] 本轮${nextPhase === "rest" ? "休息" : "运行"}时长：` + formatScheduleDuration(duration));
		}
		function isWorkExpired() {
			const { scheduleSettings } = getState();
			return scheduleSettings.enabled && phase === "work" && endsAt > 0 && now() >= endsAt;
		}
		function isRestActive() {
			return phase === "rest" && endsAt > 0 && now() < endsAt;
		}
		function shouldEnterRest(currentLoopId) {
			const { enabled, loopId } = getState();
			const captcha = getCaptcha();
			return enabled && currentLoopId === loopId && !captcha.isBypassInProgress() && !captcha.hasActiveVerification() && isWorkExpired();
		}
		async function waitForWork(currentLoopId) {
			if (!getState().scheduleSettings.enabled) return true;
			if (endsAt === 0) startPhase("work");
			while (true) {
				const { enabled, loopId, scheduleSettings } = getState();
				if (!enabled || currentLoopId !== loopId) return false;
				if (!scheduleSettings.enabled) {
					reset();
					return true;
				}
				if (phase === "work") {
					if (!isWorkExpired()) return true;
					startPhase("rest");
				}
				if (getCaptcha().stopIfVerificationFound()) return false;
				const remaining = endsAt - now();
				if (remaining <= 0) {
					if (await prepareForWork?.() === false) {
						await sleepFor(CONFIG.gameAutoFishingPollInterval);
						continue;
					}
					startPhase("work");
					return true;
				}
				setStatus(await onRestTick?.() || "定时休息中");
				setNextDelay(`剩余 ${formatScheduleDuration(remaining)}`);
				renderStatus(remaining);
				await sleepFor(Math.min(1e3, remaining));
			}
		}
		return {
			getSnapshot,
			isRestActive,
			isWorkExpired,
			reset,
			shouldEnterRest,
			startWork() {
				startPhase("work");
			},
			waitForWork
		};
	}
	var AUTO_BIOME_WEIGHTS = [
		0,
		5,
		10
	];
	var AUTO_BAIT_GRADES = [
		"default",
		"low",
		"medium",
		"high",
		"super"
	];
	var GAME_AUTO_FISHING_BAIT_GRADES = ["auto", ...AUTO_BAIT_GRADES];
	var AUTO_BAIT_PURCHASE_QUANTITIES = [100, 1e3];
	function loadClickDelaySettings() {
		try {
			return normalizeClickDelaySettings(JSON.parse(localStorage.getItem(CLICK_DELAY_SETTINGS_STORAGE_KEY)), DEFAULT_CLICK_DELAY_SETTINGS);
		} catch (error) {
			console.warn("[自动抛竿] 无法读取点击间隔设置：", error);
			return { ...DEFAULT_CLICK_DELAY_SETTINGS };
		}
	}
	function saveClickDelaySettings(clickDelaySettings) {
		try {
			localStorage.setItem(CLICK_DELAY_SETTINGS_STORAGE_KEY, JSON.stringify(clickDelaySettings));
		} catch (error) {
			console.warn("[自动抛竿] 无法保存点击间隔设置：", error);
		}
	}
	function loadEnabled() {
		try {
			return localStorage.getItem(STORAGE_KEY) === "1";
		} catch {
			return false;
		}
	}
	function saveEnabled(value) {
		try {
			localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
		} catch (error) {
			console.warn("[自动抛竿] 无法保存设置：", error);
		}
	}
	function loadGameAutoFishingSettings() {
		const defaults = {
			baitGrade: "auto",
			enabled: false
		};
		try {
			const savedSettings = JSON.parse(localStorage.getItem(GAME_AUTO_FISHING_SETTINGS_STORAGE_KEY));
			if (!savedSettings || typeof savedSettings !== "object") return defaults;
			return {
				baitGrade: "auto",
				enabled: savedSettings.enabled === true
			};
		} catch (error) {
			console.warn("[游戏内置自动钓鱼] 无法读取设置：", error);
			return defaults;
		}
	}
	function saveGameAutoFishingSettings(gameAutoFishingSettings) {
		try {
			localStorage.setItem(GAME_AUTO_FISHING_SETTINGS_STORAGE_KEY, JSON.stringify(gameAutoFishingSettings));
		} catch (error) {
			console.warn("[游戏内置自动钓鱼] 无法保存设置：", error);
		}
	}
	function loadCaptchaBypassEnabled() {
		try {
			const savedValue = localStorage.getItem(CAPTCHA_BYPASS_STORAGE_KEY);
			return savedValue === null ? true : savedValue === "1";
		} catch {
			return true;
		}
	}
	function saveCaptchaBypassEnabled(value) {
		try {
			localStorage.setItem(CAPTCHA_BYPASS_STORAGE_KEY, value ? "1" : "0");
		} catch (error) {
			console.warn("[自动抛竿] 无法保存自动过验证设置：", error);
		}
	}
	function normalizeVerificationHistory(history) {
		if (!Array.isArray(history)) return [];
		return history.map((entry) => {
			const timestamp = Number(entry?.timestamp);
			if (!Number.isFinite(timestamp) || timestamp <= 0 || typeof entry?.success !== "boolean") return null;
			return {
				success: entry.success,
				timestamp: Math.floor(timestamp)
			};
		}).filter(Boolean).sort((left, right) => right.timestamp - left.timestamp).slice(0, 5);
	}
	function addVerificationHistoryEntry(history, entry) {
		return normalizeVerificationHistory([entry, ...normalizeVerificationHistory(history)]);
	}
	function loadVerificationHistory() {
		try {
			return normalizeVerificationHistory(JSON.parse(localStorage.getItem(VERIFICATION_HISTORY_STORAGE_KEY)));
		} catch (error) {
			console.warn("[自动过验证] 无法读取验证记录：", error);
			return [];
		}
	}
	function saveVerificationHistory(history) {
		try {
			localStorage.setItem(VERIFICATION_HISTORY_STORAGE_KEY, JSON.stringify(normalizeVerificationHistory(history)));
		} catch (error) {
			console.warn("[自动过验证] 无法保存验证记录：", error);
		}
	}
	function normalizeAutoBiomeWeight(value, fallback = 5) {
		const weight = Number(value);
		return AUTO_BIOME_WEIGHTS.includes(weight) ? weight : fallback;
	}
	function normalizeAutoBiomeMaxBiome(value, fallback = 0) {
		const biomeId = Number(value);
		return Number.isInteger(biomeId) && biomeId >= 0 ? biomeId : fallback;
	}
	function migrateLegacyAutoBiomePriorityOrder(savedSettings) {
		const enabledPriorities = [];
		if (savedSettings.preferCompetitionBiomes !== false) enabledPriorities.push(AUTO_BIOME_PRIORITY_IDS.guildCompetition, AUTO_BIOME_PRIORITY_IDS.personalCompetition);
		enabledPriorities.push(AUTO_BIOME_PRIORITY_IDS.arcaneSurge);
		if (savedSettings.chaseGoldBreeze === true) enabledPriorities.push(AUTO_BIOME_PRIORITY_IDS.goldBreeze);
		if (savedSettings.preferDailyQuests === true) enabledPriorities.push(AUTO_BIOME_PRIORITY_IDS.dailyQuest);
		return [
			...enabledPriorities,
			AUTO_BIOME_PRIORITY_IDS.weightedExperience,
			...DEFAULT_AUTO_BIOME_PRIORITY_ORDER.filter((priorityId) => priorityId !== AUTO_BIOME_PRIORITY_IDS.weightedExperience && !enabledPriorities.includes(priorityId))
		];
	}
	function loadAutoBiomeSettings() {
		const defaults = {
			biomeWeight: 5,
			enabled: true,
			includeMasteryXpBonus: true,
			maxBiome: 0,
			priorityOrder: [...DEFAULT_AUTO_BIOME_PRIORITY_ORDER]
		};
		try {
			const savedSettings = JSON.parse(localStorage.getItem(AUTO_BIOME_SETTINGS_STORAGE_KEY));
			if (!savedSettings || typeof savedSettings !== "object") return defaults;
			return {
				biomeWeight: normalizeAutoBiomeWeight(savedSettings.biomeWeight, defaults.biomeWeight),
				enabled: true,
				includeMasteryXpBonus: savedSettings.includeMasteryXpBonus !== false,
				maxBiome: normalizeAutoBiomeMaxBiome(savedSettings.maxBiome, defaults.maxBiome),
				priorityOrder: Array.isArray(savedSettings.priorityOrder) ? normalizeAutoBiomePriorityOrder(savedSettings.priorityOrder) : migrateLegacyAutoBiomePriorityOrder(savedSettings)
			};
		} catch (error) {
			console.warn("[自动换图] 无法读取设置：", error);
			return defaults;
		}
	}
	function saveAutoBiomeSettings(autoBiomeSettings) {
		try {
			localStorage.setItem(AUTO_BIOME_SETTINGS_STORAGE_KEY, JSON.stringify(autoBiomeSettings));
		} catch (error) {
			console.warn("[自动换图] 无法保存设置：", error);
		}
	}
	function normalizeAutoBaitGrade(value, fallback = "low") {
		return AUTO_BAIT_GRADES.includes(value) ? value : fallback;
	}
	function normalizeGameAutoFishingBaitGrade(value, fallback = "auto") {
		return GAME_AUTO_FISHING_BAIT_GRADES.includes(value) ? value : fallback;
	}
	function normalizeAutoBaitMinimumQuantity(value, fallback = 100) {
		const quantity = Number(value);
		if (!Number.isFinite(quantity) || quantity < 1) return fallback;
		return Math.min(1e5, Math.round(quantity));
	}
	function normalizeAutoBaitPurchaseQuantity(value, fallback = 100) {
		const quantity = Number(value);
		return AUTO_BAIT_PURCHASE_QUANTITIES.includes(quantity) ? quantity : fallback;
	}
	function loadAutoBaitSettings() {
		const defaults = {
			enabled: true,
			baitGrade: 'low',
			minimumQuantity: 100,
			purchaseQuantity: 100
		};
		try {
			const savedSettings = JSON.parse(localStorage.getItem(AUTO_BAIT_SETTINGS_STORAGE_KEY));
			if (!savedSettings || typeof savedSettings !== 'object') return defaults;
			return {
				enabled: true,
				baitGrade: normalizeAutoBaitGrade(savedSettings.baitGrade ?? savedSettings.regularBaitGrade, defaults.baitGrade),
				minimumQuantity: normalizeAutoBaitMinimumQuantity(savedSettings.minimumQuantity, defaults.minimumQuantity),
				purchaseQuantity: normalizeAutoBaitPurchaseQuantity(savedSettings.purchaseQuantity, defaults.purchaseQuantity)
			};
		} catch (error) {
			console.warn('[自动买鱼饵] 无法读取设置：', error);
			return defaults;
		}
	}
	function saveAutoBaitSettings(autoBaitSettings) {
		try {
			localStorage.setItem(AUTO_BAIT_SETTINGS_STORAGE_KEY, JSON.stringify(autoBaitSettings));
		} catch (error) {
			console.warn("[自动买鱼饵] 无法保存设置：", error);
		}
	}
	function loadAutoBossSettings() {
		const defaults = { enabled: true };
		try {
			return { enabled: true };
		} catch (error) {
			console.warn("[自动打 Boss] 无法读取设置：", error);
			return defaults;
		}
	}
	function saveAutoBossSettings(autoBossSettings) {
		try {
			localStorage.setItem(AUTO_BOSS_SETTINGS_STORAGE_KEY, JSON.stringify(autoBossSettings));
		} catch (error) {
			console.warn("[自动打 Boss] 无法保存设置：", error);
		}
	}
	function normalizeScheduleMinutes(value, fallback) {
		const minutes = Number(value);
		if (!Number.isFinite(minutes) || minutes < 1) return fallback;
		return Math.min(1440, Math.round(minutes));
	}
	function loadScheduleSettings() {
		const defaults = {
			enabled: false,
			gameAutoFishingDuringRest: false,
			workMinutes: 60,
			restMinutes: 10
		};
		try {
			const savedSettings = JSON.parse(localStorage.getItem(SCHEDULE_SETTINGS_STORAGE_KEY));
			if (!savedSettings || typeof savedSettings !== "object") return defaults;
			return {
				enabled: false,
				gameAutoFishingDuringRest: false,
				workMinutes: normalizeScheduleMinutes(savedSettings.workMinutes, defaults.workMinutes),
				restMinutes: normalizeScheduleMinutes(savedSettings.restMinutes, defaults.restMinutes)
			};
		} catch (error) {
			console.warn("[自动抛竿] 无法读取定时休息设置：", error);
			return defaults;
		}
	}
	function saveScheduleSettings(scheduleSettings) {
		try {
			localStorage.setItem(SCHEDULE_SETTINGS_STORAGE_KEY, JSON.stringify(scheduleSettings));
		} catch (error) {
			console.warn("[自动抛竿] 无法保存定时休息设置：", error);
		}
	}
	function normalizeScheduleRuntime(runtime) {
		const schedulePhase = runtime?.schedulePhase;
		const scheduleDuration = Number(runtime?.scheduleDuration);
		const scheduleEndsAt = Number(runtime?.scheduleEndsAt);
		if (schedulePhase !== "work" && schedulePhase !== "rest" || !Number.isFinite(scheduleDuration) || scheduleDuration <= 0 || !Number.isFinite(scheduleEndsAt) || scheduleEndsAt <= 0) return {
			scheduleDuration: 0,
			scheduleEndsAt: 0,
			schedulePhase: "work"
		};
		return {
			scheduleDuration,
			scheduleEndsAt,
			schedulePhase
		};
	}
	function loadScheduleRuntime() {
		try {
			return normalizeScheduleRuntime(JSON.parse(localStorage.getItem(SCHEDULE_RUNTIME_STORAGE_KEY)));
		} catch (error) {
			console.warn("[自动抛竿] 无法读取定时休息进度：", error);
			return normalizeScheduleRuntime(null);
		}
	}
	function saveScheduleRuntime(runtime) {
		try {
			localStorage.setItem(SCHEDULE_RUNTIME_STORAGE_KEY, JSON.stringify(normalizeScheduleRuntime(runtime)));
		} catch (error) {
			console.warn("[自动抛竿] 无法保存定时休息进度：", error);
		}
	}
	function loadPanelCollapsed() {
		const collapseByDefault = window.matchMedia("(max-width: 767px)").matches;
		try {
			const savedValue = localStorage.getItem(PANEL_COLLAPSED_STORAGE_KEY);
			return savedValue === null ? collapseByDefault : savedValue === "1";
		} catch {
			return collapseByDefault;
		}
	}
	function savePanelCollapsed(value) {
		try {
			localStorage.setItem(PANEL_COLLAPSED_STORAGE_KEY, value ? "1" : "0");
		} catch (error) {
			console.warn("[自动抛竿] 无法保存面板折叠状态：", error);
		}
	}
	var userscriptFileName = "arcane-angler-cast.user.js";
	`${userscriptFileName}`;
	var panel_default = "* {\n    box-sizing: border-box;\n}\n\n.panel {\n    width: 280px;\n    max-width: calc(100vw - 32px);\n    padding: 14px;\n    border: 1px solid rgba(255, 255, 255, 0.18);\n    border-radius: 12px;\n    background: rgba(18, 18, 24, 0.94);\n    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.42);\n    color: #ffffff;\n    backdrop-filter: blur(12px);\n}\n\n.panel[data-collapsed='true'] {\n    width: auto;\n    padding: 7px;\n}\n\n.panel[data-collapsed='true'] .panel-content,\n.panel[data-collapsed='true'] .title-text {\n    display: none;\n}\n\n.header {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 10px;\n}\n\n.title {\n    display: flex;\n    align-items: center;\n    gap: 5px;\n    font-size: 15px;\n    font-weight: 700;\n}\n\n.collapse-toggle {\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 26px;\n    height: 26px;\n    flex-shrink: 0;\n    padding: 0;\n    border: 1px solid rgba(255, 255, 255, 0.16);\n    border-radius: 7px;\n    background: rgba(255, 255, 255, 0.08);\n    color: rgba(255, 255, 255, 0.88);\n    font-size: 16px;\n    line-height: 1;\n    cursor: pointer;\n}\n\n.collapse-toggle:hover {\n    background: rgba(255, 255, 255, 0.14);\n}\n\n.panel-content {\n    max-height: calc(100vh - 96px);\n    overflow-x: hidden;\n    overflow-y: auto;\n    overscroll-behavior: contain;\n    margin-top: 10px;\n    padding-right: 2px;\n    scrollbar-color: rgba(255, 255, 255, 0.28) transparent;\n    scrollbar-width: thin;\n}\n\n.panel-content::-webkit-scrollbar {\n    width: 6px;\n    height: 0;\n}\n\n.panel-content::-webkit-scrollbar-track {\n    background: transparent;\n}\n\n.panel-content::-webkit-scrollbar-thumb {\n    border-radius: 999px;\n    background: rgba(255, 255, 255, 0.24);\n}\n\n.panel-content::-webkit-scrollbar-thumb:hover {\n    background: rgba(255, 255, 255, 0.38);\n}\n\n.panel-content::-webkit-scrollbar-corner {\n    background: transparent;\n}\n\n.tabs {\n    display: grid;\n    grid-template-columns: repeat(3, minmax(0, 1fr));\n    gap: 4px;\n    margin-bottom: 10px;\n    padding: 3px;\n    border-radius: 8px;\n    background: rgba(255, 255, 255, 0.07);\n}\n\n.panel-tab {\n    padding: 6px 8px;\n    border: 0;\n    border-radius: 6px;\n    background: transparent;\n    color: rgba(255, 255, 255, 0.56);\n    font-size: 12px;\n    font-weight: 700;\n    cursor: pointer;\n}\n\n.panel-tab[data-active='true'] {\n    background: #6d5dfc;\n    color: #ffffff;\n}\n\n.panel-view[hidden] {\n    display: none;\n}\n\n.row {\n    display: flex;\n    justify-content: space-between;\n    gap: 10px;\n    margin-top: 7px;\n    font-size: 12px;\n    line-height: 1.4;\n}\n\n.label {\n    flex-shrink: 0;\n    color: rgba(255, 255, 255, 0.58);\n}\n\n.value {\n    min-width: 0;\n    overflow-wrap: anywhere;\n    text-align: right;\n    color: rgba(255, 255, 255, 0.92);\n}\n\n.field {\n    display: block;\n    margin-top: 12px;\n}\n\n.field-label {\n    display: block;\n    margin-bottom: 5px;\n    color: rgba(255, 255, 255, 0.58);\n    font-size: 12px;\n}\n\n.input {\n    width: 100%;\n    padding: 8px 9px;\n    border: 1px solid rgba(255, 255, 255, 0.18);\n    border-radius: 7px;\n    outline: none;\n    background: #252530;\n    color: rgba(255, 255, 255, 0.92);\n    color-scheme: dark;\n    font-size: 12px;\n}\n\n.input option {\n    background: #252530;\n    color: rgba(255, 255, 255, 0.92);\n}\n\n.input:focus {\n    border-color: #6d5dfc;\n}\n\n.input::placeholder {\n    color: rgba(255, 255, 255, 0.32);\n}\n\n.field-help {\n    margin-top: 6px;\n    color: rgba(255, 255, 255, 0.5);\n    font-size: 11px;\n    line-height: 1.45;\n}\n\n.field-help[hidden] {\n    display: none;\n}\n\n.field-help a {\n    color: #9ea5ff;\n    text-decoration: underline;\n}\n\n.settings-section + .settings-section {\n    margin-top: 14px;\n    padding-top: 14px;\n    border-top: 1px solid rgba(255, 255, 255, 0.1);\n}\n\n.settings-title {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 8px;\n    list-style: none;\n    color: rgba(255, 255, 255, 0.88);\n    font-size: 12px;\n    font-weight: 700;\n    cursor: pointer;\n}\n\n.settings-title::-webkit-details-marker {\n    display: none;\n}\n\n.settings-title::after {\n    content: '›';\n    color: rgba(255, 255, 255, 0.45);\n    font-size: 18px;\n    line-height: 1;\n    transform: rotate(0deg);\n    transition: transform 160ms ease;\n}\n\n.settings-section[open] > .settings-title::after {\n    transform: rotate(90deg);\n}\n\n.verification-history {\n    display: grid;\n    gap: 6px;\n    margin-top: 10px;\n}\n\n.verification-history-item {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 10px;\n    min-height: 32px;\n    padding: 6px 8px;\n    border: 1px solid rgba(255, 255, 255, 0.1);\n    border-radius: 7px;\n    background: rgba(255, 255, 255, 0.04);\n}\n\n.verification-history-time,\n.verification-history-empty {\n    color: rgba(255, 255, 255, 0.62);\n    font-size: 11px;\n}\n\n.verification-history-empty {\n    padding: 8px 0;\n    text-align: center;\n}\n\n.verification-history-status {\n    flex: 0 0 auto;\n    font-size: 11px;\n    font-weight: 700;\n}\n\n.verification-history-status[data-success='true'] {\n    color: #6ee7a2;\n}\n\n.verification-history-status[data-success='false'] {\n    color: #ff9a9a;\n}\n\n.priority-heading {\n    margin-top: 12px;\n}\n\n.priority-list {\n    display: grid;\n    gap: 5px;\n}\n\n.priority-item {\n    display: grid;\n    grid-template-columns: auto minmax(0, 1fr) auto auto;\n    align-items: center;\n    gap: 6px;\n    min-height: 34px;\n    padding: 5px 6px;\n    border: 1px solid rgba(255, 255, 255, 0.12);\n    border-radius: 7px;\n    background: rgba(255, 255, 255, 0.045);\n    color: rgba(255, 255, 255, 0.86);\n    font-size: 11px;\n    cursor: grab;\n}\n\n.priority-item[data-dragging='true'] {\n    border-color: rgba(109, 93, 252, 0.72);\n    background: rgba(109, 93, 252, 0.18);\n    opacity: 0.72;\n    cursor: grabbing;\n}\n\n.priority-item[data-enabled='false'] {\n    color: rgba(255, 255, 255, 0.44);\n    opacity: 0.72;\n}\n\n.priority-item[data-enabled='boundary'] {\n    border-color: rgba(251, 191, 36, 0.42);\n    background: rgba(251, 191, 36, 0.08);\n}\n\n.priority-drag-handle {\n    color: rgba(255, 255, 255, 0.38);\n    font-size: 15px;\n    line-height: 1;\n}\n\n.priority-label {\n    overflow: hidden;\n    font-weight: 700;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.priority-state {\n    padding: 2px 5px;\n    border-radius: 999px;\n    background: rgba(74, 222, 128, 0.12);\n    color: #86efac;\n    font-size: 9px;\n    white-space: nowrap;\n}\n\n.priority-item[data-enabled='false'] .priority-state {\n    background: rgba(255, 255, 255, 0.08);\n    color: rgba(255, 255, 255, 0.48);\n}\n\n.priority-item[data-enabled='boundary'] .priority-state {\n    background: rgba(251, 191, 36, 0.12);\n    color: #fcd34d;\n}\n\n.priority-actions {\n    display: inline-flex;\n    gap: 3px;\n}\n\n.priority-move {\n    display: inline-flex;\n    align-items: center;\n    justify-content: center;\n    width: 22px;\n    height: 22px;\n    padding: 0;\n    border: 1px solid rgba(255, 255, 255, 0.14);\n    border-radius: 5px;\n    background: rgba(255, 255, 255, 0.06);\n    color: rgba(255, 255, 255, 0.72);\n    font-size: 11px;\n    cursor: pointer;\n}\n\n.priority-move:hover:not(:disabled) {\n    background: rgba(109, 93, 252, 0.22);\n}\n\n.priority-move:disabled {\n    cursor: default;\n    opacity: 0.28;\n}\n\n.choice-list {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 6px;\n    margin-top: 8px;\n}\n\n.choice-list-three {\n    grid-template-columns: repeat(3, minmax(0, 1fr));\n}\n\n.choice-option {\n    display: flex;\n    align-items: center;\n    gap: 6px;\n    padding: 7px 8px;\n    border: 1px solid rgba(255, 255, 255, 0.12);\n    border-radius: 7px;\n    color: rgba(255, 255, 255, 0.78);\n    font-size: 11px;\n    cursor: pointer;\n}\n\n.choice-option:has(input:checked) {\n    border-color: rgba(109, 93, 252, 0.72);\n    background: rgba(109, 93, 252, 0.14);\n    color: #ffffff;\n}\n\n.choice-option input {\n    margin: 0;\n    accent-color: #6d5dfc;\n}\n\n.settings-group[hidden] {\n    display: none;\n}\n\n.number-grid {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 8px;\n}\n\n.secondary-button {\n    width: 100%;\n    margin-top: 9px;\n    padding: 7px 10px;\n    border: 1px solid rgba(109, 93, 252, 0.55);\n    border-radius: 7px;\n    background: rgba(109, 93, 252, 0.12);\n    color: #b9b5ff;\n    font-size: 11px;\n    font-weight: 700;\n    cursor: pointer;\n}\n\n.secondary-button:hover {\n    background: rgba(109, 93, 252, 0.22);\n}\n\n.secondary-button:disabled {\n    cursor: default;\n    opacity: 0.48;\n}\n\n.toggle {\n    width: 100%;\n    margin-top: 12px;\n    padding: 9px 12px;\n    border: 0;\n    border-radius: 8px;\n    background: #6d5dfc;\n    color: #ffffff;\n    font-size: 13px;\n    font-weight: 700;\n    cursor: pointer;\n}\n\n.toggle:hover {\n    filter: brightness(1.08);\n}\n\n.toggle[data-enabled='true'] {\n    background: #d34848;\n}\n\n.option-row {\n    display: flex;\n    align-items: center;\n    justify-content: space-between;\n    gap: 10px;\n    margin-top: 10px;\n    color: rgba(255, 255, 255, 0.88);\n    font-size: 12px;\n    cursor: pointer;\n}\n\n.switch {\n    position: relative;\n    width: 38px;\n    height: 22px;\n    flex-shrink: 0;\n}\n\n.switch input {\n    position: absolute;\n    width: 1px;\n    height: 1px;\n    opacity: 0;\n}\n\n.switch-track {\n    display: block;\n    width: 100%;\n    height: 100%;\n    border-radius: 999px;\n    background: rgba(255, 255, 255, 0.2);\n    transition: background 0.15s ease;\n}\n\n.switch-track::after {\n    position: absolute;\n    top: 3px;\n    left: 3px;\n    width: 16px;\n    height: 16px;\n    border-radius: 50%;\n    background: #ffffff;\n    content: '';\n    transition: transform 0.15s ease;\n}\n\n.switch input:checked + .switch-track {\n    background: #6d5dfc;\n}\n\n.switch input:checked + .switch-track::after {\n    transform: translateX(16px);\n}\n\n.switch input:focus-visible + .switch-track {\n    outline: 2px solid #9ea5ff;\n    outline-offset: 2px;\n}\n\n.stats-filters {\n    display: grid;\n    gap: 6px;\n    margin-bottom: 8px;\n}\n\n.stats-filter span {\n    display: block;\n    margin-bottom: 3px;\n    color: rgba(255, 255, 255, 0.5);\n    font-size: 10px;\n}\n\n.stats-select {\n    width: 100%;\n    padding: 6px 7px;\n    border: 1px solid rgba(255, 255, 255, 0.14);\n    border-radius: 6px;\n    outline: none;\n    background: #252530;\n    color: rgba(255, 255, 255, 0.9);\n    font-size: 10px;\n}\n\n.stats-select:focus {\n    border-color: #6d5dfc;\n}\n\n.stats-scope {\n    overflow: hidden;\n    color: rgba(255, 255, 255, 0.72);\n    font-size: 10px;\n    font-weight: 700;\n    text-align: center;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.stats-start {\n    margin: 3px 0 9px;\n    color: rgba(255, 255, 255, 0.48);\n    font-size: 10px;\n    text-align: center;\n}\n\n.stats-grid {\n    display: grid;\n    grid-template-columns: repeat(2, minmax(0, 1fr));\n    gap: 6px;\n}\n\n.stat-card {\n    min-width: 0;\n    padding: 8px;\n    border: 1px solid rgba(255, 255, 255, 0.1);\n    border-radius: 8px;\n    background: rgba(255, 255, 255, 0.055);\n}\n\n.stat-card-label {\n    display: block;\n    margin-bottom: 3px;\n    color: rgba(255, 255, 255, 0.5);\n    font-size: 10px;\n}\n\n.stat-card-value {\n    display: block;\n    overflow: hidden;\n    color: rgba(255, 255, 255, 0.94);\n    font-size: 13px;\n    line-height: 1.25;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.stat-card-value[data-tone='income'],\n.stat-card-value[data-tone='positive'] {\n    color: #4ade80;\n}\n\n.stat-card-value[data-tone='gold'] {\n    color: #fbbf24;\n}\n\n.stat-card-value[data-tone='cost'],\n.stat-card-value[data-tone='negative'] {\n    color: #f87171;\n}\n\n.stats-section-title {\n    margin: 12px 0 6px;\n    color: rgba(255, 255, 255, 0.62);\n    font-size: 11px;\n    font-weight: 700;\n}\n\n.stats-list {\n    display: flex;\n    flex-wrap: wrap;\n    gap: 5px;\n}\n\n.stat-chip {\n    max-width: 100%;\n    overflow: hidden;\n    padding: 4px 6px;\n    border-radius: 6px;\n    background: rgba(109, 93, 252, 0.16);\n    color: #d8d8df;\n    font-size: 10px;\n    text-overflow: ellipsis;\n    white-space: nowrap;\n}\n\n.stat-chip[data-tone='uncommon'] {\n    background: rgba(132, 204, 22, 0.14);\n    color: #84cc16;\n}\n\n.stat-chip[data-tone='common'] {\n    background: rgba(156, 163, 175, 0.14);\n    color: #9ca3af;\n}\n\n.stat-chip[data-tone='fine'] {\n    background: rgba(59, 130, 246, 0.14);\n    color: #3b82f6;\n}\n\n.stat-chip[data-tone='rare'] {\n    background: rgba(168, 85, 247, 0.14);\n    color: #a855f7;\n}\n\n.stat-chip[data-tone='epic'] {\n    background: rgba(236, 72, 153, 0.14);\n    color: #ec4899;\n}\n\n.stat-chip[data-tone='legendary'] {\n    background: rgba(245, 158, 11, 0.14);\n    color: #f59e0b;\n}\n\n.stat-chip[data-tone='mythic'] {\n    background: rgba(239, 68, 68, 0.14);\n    color: #ef4444;\n}\n\n.stat-chip[data-tone='exotic'] {\n    background: rgba(6, 182, 212, 0.14);\n    color: #06b6d4;\n}\n\n.stat-chip[data-tone='arcane'] {\n    background: rgba(168, 85, 247, 0.14);\n    color: #a855f7;\n}\n\n.stat-chip[data-tone='relic'],\n.stat-chip[data-tone='treasure'] {\n    background: rgba(242, 204, 96, 0.14);\n    color: #f2cc60;\n}\n\n.stat-chip[data-tone='gear'] {\n    background: rgba(86, 212, 221, 0.14);\n    color: #7ce7ee;\n}\n\n.empty-stat {\n    color: rgba(255, 255, 255, 0.42);\n    font-size: 10px;\n    line-height: 1.45;\n}\n\n.stats-cost-note {\n    margin-top: 7px;\n    color: #fbbf24;\n    font-size: 10px;\n    line-height: 1.4;\n}\n\n.stats-cost-note[hidden] {\n    display: none;\n}\n\n.reset-stats {\n    width: 100%;\n    margin-top: 12px;\n    padding: 7px 10px;\n    border: 1px solid rgba(211, 72, 72, 0.52);\n    border-radius: 7px;\n    background: rgba(211, 72, 72, 0.12);\n    color: #ff9d9d;\n    font-size: 11px;\n    font-weight: 700;\n    cursor: pointer;\n}\n\n.reset-stats:hover {\n    background: rgba(211, 72, 72, 0.22);\n}\n";
	function loadLoginMonitorSettings() {
		try {
			return {
				enabled: localStorage.getItem(LOGIN_MONITOR_ENABLED_STORAGE_KEY) === "1",
				machineName: localStorage.getItem(LOGIN_MONITOR_MACHINE_NAME_STORAGE_KEY)?.trim() ?? "",
				botKey: localStorage.getItem(LOGIN_MONITOR_BOT_KEY_STORAGE_KEY)?.trim() ?? "",
				username: localStorage.getItem(LOGIN_MONITOR_USERNAME_STORAGE_KEY)?.trim() ?? "",
				password: localStorage.getItem(LOGIN_MONITOR_PASSWORD_STORAGE_KEY) ?? "",
				rareDropNotifyEnabled: localStorage.getItem(LOGIN_MONITOR_RARE_DROP_NOTIFY_STORAGE_KEY) === "1"
			};
		} catch (error) {
			console.warn("[监控登录] 无法读取设置：", error);
			return { enabled: false, machineName: "", botKey: "", username: "", password: "", rareDropNotifyEnabled: false };
		}
	}
	function saveLoginMonitorSettings(settings) {
		try {
			localStorage.setItem(LOGIN_MONITOR_ENABLED_STORAGE_KEY, settings.enabled ? "1" : "0");
			if (settings.machineName) localStorage.setItem(LOGIN_MONITOR_MACHINE_NAME_STORAGE_KEY, settings.machineName);
			else localStorage.removeItem(LOGIN_MONITOR_MACHINE_NAME_STORAGE_KEY);
			if (settings.botKey) localStorage.setItem(LOGIN_MONITOR_BOT_KEY_STORAGE_KEY, settings.botKey);
			else localStorage.removeItem(LOGIN_MONITOR_BOT_KEY_STORAGE_KEY);
			if (settings.username) localStorage.setItem(LOGIN_MONITOR_USERNAME_STORAGE_KEY, settings.username);
			else localStorage.removeItem(LOGIN_MONITOR_USERNAME_STORAGE_KEY);
			if (settings.password) localStorage.setItem(LOGIN_MONITOR_PASSWORD_STORAGE_KEY, settings.password);
			else localStorage.removeItem(LOGIN_MONITOR_PASSWORD_STORAGE_KEY);
			localStorage.setItem(LOGIN_MONITOR_RARE_DROP_NOTIFY_STORAGE_KEY, settings.rareDropNotifyEnabled ? "1" : "0");
		} catch (error) {
			console.warn("[监控登录] 无法保存设置：", error);
		}
	}
	function loadLoginMonitorLogoutNotified() {
		try {
			return localStorage.getItem(LOGIN_MONITOR_LOGOUT_NOTIFIED_STORAGE_KEY) === "1";
		} catch {
			return false;
		}
	}
	function saveLoginMonitorLogoutNotified(value) {
		try {
			localStorage.setItem(LOGIN_MONITOR_LOGOUT_NOTIFIED_STORAGE_KEY, value ? "1" : "0");
		} catch (error) {
			console.warn("[监控登录] 无法保存登出通知标记：", error);
		}
	}
	var loginMonitorSettings = loadLoginMonitorSettings();
	var loginMonitorRunning = false;
	var loginMonitorLoggingIn = false;
	var loginMonitorStatusEl = null;
	function setLoginMonitorStatus(text) {
		if (loginMonitorStatusEl) loginMonitorStatusEl.textContent = text;
		console.log("[监控登录] " + text);
	}

	function sendWxBot(botKey, msg) {
		if (!botKey) return;
		const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${botKey}`;
		const payload = {
			msgtype: "markdown_v2",
			markdown_v2: { content: msg }
		};

		try {
			GM_xmlhttpRequest({
				method: 'POST',
				url: url,
				headers: { 'Content-Type': 'application/json' },
				data: JSON.stringify(payload),
				timeout: 10000,
				onload: (res) => {
					try {
						const data = JSON.parse(res.responseText);
						if (data.errcode === 0) {
							console.log('✅ 微信消息推送成功');
						} else {
							console.error('❌ 微信消息推送失败:', data);
						}
					} catch (parseErr) {
						console.error('❌ 微信响应解析失败:', res.responseText);
					}
				},
				onerror: (err) => {
					console.error('❌ 微信推送异常:', err);
				},
				ontimeout: () => {
					console.error('❌ 微信推送超时');
				}
			});
		} catch (e) {
			// 降级使用 fetch（可能需要 CORS 支持）
			fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			}).catch(err => {
				console.error('❌ 微信推送降级失败:', err);
			});
		}
	}

	function formatBotMessage(content) {
		const machineName = loginMonitorSettings.machineName;
		const prefix = machineName ? `【${machineName}】` : '【ArcaneAngler】';
		return `${prefix} ${content}`;
	}

	function isLoggedOut() {
		// 查找"即刻游玩"按钮（仅可见的）
		const buttons = document.querySelectorAll('button');
		for (const btn of buttons) {
			if (btn.textContent.includes('即刻游玩')) {
				// 检查按钮是否可见（防止登录弹窗打开时误判）
				const rect = btn.getBoundingClientRect();
				const style = getComputedStyle(btn);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					return true;
				}
			}
		}
		return false;
	}

	function clickPlayButton() {
		const buttons = document.querySelectorAll('button');
		for (const btn of buttons) {
			if (btn.textContent.trim() === '游玩') {
				btn.click();
				console.log('✅ 已点击游玩按钮');
				// 点击成功后发送通知
				if (loginMonitorRunning) {
					const botKey = loginMonitorSettings.botKey;
					if (botKey) {
						const msg = formatBotMessage('✅ 网页重新登录成功，已恢复在线状态。');
						sendWxBot(botKey, msg);
					}
					// 登录成功，清除登出通知标记，允许下次登出再次推送
					saveLoginMonitorLogoutNotified(false);
				}
				// 延迟重置登录标志，让页面有时间完成跳转
				setTimeout(() => {
					if (!loginMonitorRunning) return;
					// 确认"即刻游玩"按钮已消失（真正登录成功）才重置
					if (!isLoggedOut()) {
						loginMonitorLoggingIn = false;
					}
				}, 5000);
				return true;
			}
		}
		console.log('⚠️ 未找到游玩按钮，等待重试...');
		return false;
	}

	function performAutoLogin() {
		if (!loginMonitorRunning) return;
		// 防止重复触发登录流程
		if (loginMonitorLoggingIn) return;
		loginMonitorLoggingIn = true;

		// 发送登出通知（只在本次登出流程首次触发时推送一次。
		// 通过 LOGOUT_NOTIFIED 持久化标记确保：即使页面刷新/重载也不会重复推送）
		const botKey = loginMonitorSettings.botKey;
		if (botKey && !loadLoginMonitorLogoutNotified()) {
			const msg = formatBotMessage('⚠️ 检测到网页已登出，正在自动重新登录...');
			sendWxBot(botKey, msg);
			saveLoginMonitorLogoutNotified(true);
		}

		// 点击「即刻游玩」按钮打开登录弹窗，然后等待弹窗出现
		tryClickPlayAndWait();
	}

	function tryClickPlayAndWait() {
		if (!loginMonitorRunning) return;

		// 先检查登录输入框是否已可见（登录弹窗已打开）
		const existingInputs = findLoginInputs();
		if (existingInputs) {
			console.log('🔑 登录弹窗已打开，直接填充登录');
			fillAndLogin();
			return;
		}

		// 点击「即刻游玩」按钮打开登录弹窗
		const clicked = tryClickPlayButtonOnce();
		if (!clicked) {
			console.log('⚠️ 未找到「即刻游玩」按钮');
			loginMonitorLoggingIn = false;
			return;
		}

		// 点击后等待登录弹窗完全出现（每 500ms 检查一次，最多 10 秒）
		waitForLoginForm(0);
	}

	function tryClickPlayButtonOnce() {
		const playButtons = document.querySelectorAll('button');
		for (const btn of playButtons) {
			if (btn.textContent.includes('即刻游玩')) {
				const rect = btn.getBoundingClientRect();
				const style = getComputedStyle(btn);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					btn.click();
					console.log('🎣 点击「即刻游玩」按钮');
					return true;
				}
			}
		}
		return false;
	}

	function waitForLoginForm(attempts) {
		if (!loginMonitorRunning) return;
		if (attempts > 20) {
			console.log('⚠️ 登录弹窗未出现，停止等待');
			loginMonitorLoggingIn = false;
			return;
		}

		// 查找登录输入框（「即刻游玩」按钮是否存在不影响判断，
		// 因为登录弹窗可能以模态框形式叠加在页面上方）
		const loginInputs = findLoginInputs();
		if (!loginInputs) {
			// 登录弹窗尚未打开
			console.log('⏳ 等待登录弹窗打开...');
			// 如果页面仍显示「即刻游玩」，尝试再次点击
			if (isLoggedOut()) {
				tryClickPlayButtonOnce();
			}
			setTimeout(() => waitForLoginForm(attempts + 1), 500);
			return;
		}

		console.log('✅ 登录弹窗已出现');

		// 从悬浮窗读取账号密码
		const savedUsername = loginMonitorSettings.username;
		const savedPassword = loginMonitorSettings.password;

		if (!savedUsername || !savedPassword) {
			console.log('⚠️ 未配置账号密码，请在悬浮窗填写');
			setLoginMonitorStatus('请填写账号密码');
			// 尝试直接点击登录，让用户看到错误
			tryClickLogin();
			return;
		}

		// 直接用悬浮窗配置的账号密码填充登录表单
		console.log('🔑 使用配置的账号密码填充登录表单...');
		setReactInputValue(loginInputs.account, savedUsername);
		setReactInputValue(loginInputs.password, savedPassword);

		// 验证填充结果
		setTimeout(() => {
			if (!loginMonitorRunning) return;
			const current = findLoginInputs();
			if (!current) {
				setTimeout(() => waitForLoginForm(attempts + 1), 500);
				return;
			}

			// 再次确认值已设置
			const accountFilled = current.account.value.trim() !== '';
			const passwordFilled = current.password.value.trim() !== '';

			if (accountFilled && passwordFilled) {
				console.log('✅ 账号密码填充成功');
				tryClickLogin();
			} else if (accountFilled || passwordFilled) {
				// 部分填充成功，补充填充缺失的
				console.log('⚠️ 部分字段填充成功，补充剩余字段...');
				if (!accountFilled) {
					setReactInputValue(current.account, savedUsername);
				}
				if (!passwordFilled) {
					setReactInputValue(current.password, savedPassword);
				}
				setTimeout(() => tryClickLogin(), 300);
			} else {
				console.log('⚠️ 填充后值被清空，重试...');
				// 可能是 React 受控组件覆盖，尝试再次写入
				setReactInputValue(current.account, savedUsername);
				setReactInputValue(current.password, savedPassword);
				setTimeout(() => {
					if (!loginMonitorRunning) return;
					const final = findLoginInputs();
					if (final) {
						// 第二次填充后无论结果如何都尝试登录
						if (final.account.value.trim() === '' && savedUsername) {
							// 强制赋值
							setReactInputValue(final.account, savedUsername);
						}
						if (final.password.value.trim() === '' && savedPassword) {
							setReactInputValue(final.password, savedPassword);
						}
						console.log('⚠️ 第二次填充完成，尝试登录...');
						setTimeout(() => {
							if (!loginMonitorRunning) return;
							tryClickLogin();
						}, 300);
					}
				}, 500);
			}
		}, 300);
	}

	function fillAndLogin() {
		// 直接登录弹窗已打开的场景：读取配置并填充
		const savedUsername = loginMonitorSettings.username;
		const savedPassword = loginMonitorSettings.password;

		if (!savedUsername || !savedPassword) {
			console.log('⚠️ 未配置账号密码，请在悬浮窗填写');
			setLoginMonitorStatus('请填写账号密码');
			loginMonitorLoggingIn = false;
			return;
		}

		const loginInputs = findLoginInputs();
		if (!loginInputs) {
			loginMonitorLoggingIn = false;
			return;
		}

		console.log('🔑 填充账号密码...');
		setReactInputValue(loginInputs.account, savedUsername);
		setReactInputValue(loginInputs.password, savedPassword);

		// 等待 React 状态同步后点击登录
		setTimeout(() => {
			if (!loginMonitorRunning) return;
			const current = findLoginInputs();
			if (!current) {
				loginMonitorLoggingIn = false;
				return;
			}

			if (current.account.value.trim() !== '' && current.password.value.trim() !== '') {
				tryClickLogin();
			} else {
				// 重试填充
				setReactInputValue(current.account, savedUsername);
				setReactInputValue(current.password, savedPassword);
				setTimeout(() => {
					if (!loginMonitorRunning) return;
					tryClickLogin();
				}, 300);
			}
		}, 300);
	}

	function setReactInputValue(input, value) {
		// 使用 React Fiber 方式设置值
		try {
			// 查找 React 内部属性
			const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
			const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber$'));

			// 使用原生 setter 写入值（绕过 React 的 value 拦截）
			const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
			valueSetter.call(input, value);

			if (propsKey) {
				// 直接调用 React 的 onChange
				const props = input[propsKey];
				if (typeof props.onChange === 'function') {
					const event = {
						target: input,
						currentTarget: input,
						preventDefault() {},
						stopPropagation() {},
						bubbles: true,
						cancelable: true,
						type: 'change',
						persist() {}
					};
					props.onChange(event);
				}
				// 同时派发原生 input 事件
				input.dispatchEvent(new Event('input', { bubbles: true }));
			} else if (fiberKey) {
				// 通过 Fiber 查找 onChange
				let node = input[fiberKey];
				let memoizedProps = null;
				while (node) {
					if (node.memoizedProps && typeof node.memoizedProps.onChange === 'function') {
						memoizedProps = node.memoizedProps;
						break;
					}
					node = node.return;
				}
				if (memoizedProps && typeof memoizedProps.onChange === 'function') {
					const event = {
						target: input,
						currentTarget: input,
						preventDefault() {},
						stopPropagation() {},
						bubbles: true,
						cancelable: true,
						type: 'change'
					};
					memoizedProps.onChange(event);
				}
				input.dispatchEvent(new Event('input', { bubbles: true }));
			} else {
				// 降级：直接设置并派发事件
				input.dispatchEvent(new InputEvent('input', {
					bubbles: true,
					data: value,
					inputType: 'insertText'
				}));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			}

			// 额外：用输入法模拟输入（某些 React 组件需要）
			input.focus();
			valueSetter.call(input, '');
			input.dispatchEvent(new InputEvent('input', {
				bubbles: true,
				inputType: 'deleteContentBackward'
			}));
			valueSetter.call(input, value);
			input.dispatchEvent(new InputEvent('input', {
				bubbles: true,
				data: value,
				inputType: 'insertText'
			}));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		} catch (e) {
			// 最后一招：直接赋值
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		}
	}

	function findLoginInputs() {
		// 判断标准：登录页面的账号密码输入框 + type=submit 的登录按钮（与需求文档 outerHTML 一致）
		// 悬浮窗自身没有 submit 按钮，不会误判
		try {
			// 1. 先确认登录页面存在（找到 type=submit 且文本含「登录」的按钮，即需求中的登录按钮 HTML）
			let loginBtn = null;
			const allButtons = document.querySelectorAll('button[type="submit"]');
			for (const btn of allButtons) {
				const txt = (btn.textContent || '').trim();
				if (txt.includes('登录')) {
					const rect = btn.getBoundingClientRect();
					const style = getComputedStyle(btn);
					if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
						loginBtn = btn;
						break;
					}
				}
			}
			// 没有登录按钮，说明不在登录页面
			if (!loginBtn) return null;

			// 2. 在登录页面内找账号密码输入框
			const inputs = Array.from(document.querySelectorAll('input'));
			const visibleInputs = inputs.filter(inp => {
				const rect = inp.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return false;
				// 确保不在隐藏的父容器内
				let parent = inp.parentElement;
				let inPanel = false;
				while (parent) {
					if (parent.id === 'arcane-angler-cast-panel-host') {
						inPanel = true;
						break;
					}
					const style = getComputedStyle(parent);
					if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
						return false;
					}
					parent = parent.parentElement;
				}
				return !inPanel;
			});

			if (visibleInputs.length === 0) return null;

			// 密码输入框：type=password（登录页面必有一个）
			const password = visibleInputs.find(inp => inp.type === 'password');
			if (!password) return null;

			// 账号输入框：placeholder 为 "Enter username" 的可见输入框
			const account = visibleInputs.find(inp =>
				inp.type !== 'password' &&
				((inp.placeholder || '').toLowerCase().includes('username') ||
				(inp.placeholder || '').toLowerCase().includes('user') ||
				(inp.name || '').toLowerCase() === 'username')
			);
			if (!account) return null;

			return { account, password };
		} catch (e) {
			return null;
		}
	}

	function setupReactInput(input) {
		// ============ 最可靠方案：直接调用 React Fiber 的 onChange ============
		try {
			// 找到 React 内部属性键（如 __reactProps$xxx 或 __reactFiber$xxx）
			const propsKey = Object.keys(input).find(k => k.startsWith('__reactProps$'));
			const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber$'));

			const domValue = input.value;

			if (propsKey) {
				// React 受控组件：调用其 onChange/onInput 处理函数
				const props = input[propsKey];
				// 先设置原生 value（绕过 React value 拦截）
				const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				valueSetter.call(input, domValue);

				// 模拟真实用户输入事件
				if (typeof props.onChange === 'function') {
					const event = {
						target: input,
						currentTarget: input,
						nativeEvent: {
							inputType: 'insertText',
							data: domValue,
							isTrusted: false
						},
						preventDefault() {},
						stopPropagation() {},
						bubbles: true,
						cancelable: true,
						type: 'change',
						persist() {}
					};
					props.onChange(event);
				}

				// 同时派发 input 事件作为兜底
				input.dispatchEvent(new Event('input', { bubbles: true }));
			} else if (fiberKey) {
				// 通过 Fiber 触发
				const fiber = input[fiberKey];
				let memoizedProps = null;
				let node = fiber;
				while (node) {
					if (node.memoizedProps && typeof node.memoizedProps.onChange === 'function') {
						memoizedProps = node.memoizedProps;
						break;
					}
					node = node.return;
				}

				const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				valueSetter.call(input, domValue);

				if (memoizedProps && typeof memoizedProps.onChange === 'function') {
					const event = {
						target: input,
						currentTarget: input,
						preventDefault() {},
						stopPropagation() {},
						bubbles: true,
						cancelable: true,
						type: 'change'
					};
					memoizedProps.onChange(event);
				}
				input.dispatchEvent(new Event('input', { bubbles: true }));
			} else {
				// 降级：标准 InputEvent 派发
				const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				valueSetter.call(input, domValue);
				input.dispatchEvent(new InputEvent('input', {
					bubbles: true,
					data: domValue,
					inputType: 'insertText',
					isComposing: false
				}));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			}
		} catch (e) {
			// 最后的兜底
			try {
				const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
				valueSetter.call(input, input.value);
				input.dispatchEvent(new Event('input', { bubbles: true }));
				input.dispatchEvent(new Event('change', { bubbles: true }));
			} catch (e2) {
				input.value = input.value;
				input.dispatchEvent(new Event('input', { bubbles: true }));
			}
		}
	}

	function tryClickLogin() {
		// 每次都重新查找登录按钮（防止 DOM 重渲染导致引用失效）
		const loginBtn = document.querySelector('button[type="submit"]');
		if (loginBtn && (loginBtn.textContent.includes('登录') || loginBtn.type === 'submit')) {
			// 先尝试获取当前输入值
			const current = findLoginInputs();
			if (current) {
				// 检查是否已有值（浏览器可能已经填充）
				if (current.account.value.trim() !== '' || current.password.value.trim() !== '') {
					// 同步 React 状态（使用 Fiber 或事件派发）
					setupReactInput(current.account);
					setupReactInput(current.password);
				}
			}

			// 点击登录按钮（如果 disabled 则等待启用后再点）
			const doClick = () => {
				if (!loginMonitorRunning) return;
				// 重新获取当前按钮引用
				const btn = document.querySelector('button[type="submit"]');
				if (btn && !btn.disabled) {
					btn.click();
					console.log('✅ 已点击登录按钮');
				} else if (btn && btn.disabled) {
					// 按钮 disabled，等待 500ms 后重试
					console.log('⏳ 登录按钮尚未启用，等待...');
					setTimeout(doClick, 500);
				} else {
					console.log('⚠️ 登录按钮已移除');
				}
			};
			setTimeout(doClick, 300);

			// 等待跳转后点击游玩按钮
			setTimeout(() => {
				if (!loginMonitorRunning) return;
				const clickedPlay = clickPlayButton();
				if (!clickedPlay) {
					// 等待跳转后重试
					let retryCount = 0;
					const retryPlay = () => {
						if (!loginMonitorRunning) return;
						retryCount++;
						const ok = clickPlayButton();
						if (!ok && retryCount < 10) {
							setTimeout(retryPlay, 2000);
						} else if (!ok) {
							loginMonitorLoggingIn = false;
						}
					};
					setTimeout(retryPlay, 2000);
				}
			}, 3000);
		} else {
			// 未找到登录按钮，可能弹窗还没完全出来，继续等待
			console.log('⚠️ 未找到登录按钮，继续等待...');
			setTimeout(() => waitForLoginForm(0), 1000);
		}
	}

	function checkAndLogin() {
		if (!loginMonitorRunning) return;

		if (isLoggedOut()) {
			console.log('🚨 检测到网页已登出');
			// 只有在没有正在进行的登录流程时才触发
			if (!loginMonitorLoggingIn) {
				performAutoLogin();
			}
		}

		// 每隔2秒检查一次
		setTimeout(checkAndLogin, 2000);
	}

	function startCheckFromPlay() {
		// 每次启动监控时，从「即刻游玩」按钮开始检查
		// 先检测当前页面是否有「即刻游玩」按钮
		if (!isLoggedOut()) {
			console.log('✅ 启动检查：未检测到登出（无「即刻游玩」按钮）');
			return;
		}

		// 有「即刻游玩」按钮，说明已登出，走完整自动登录流程
		console.log('🚨 启动检查：检测到已登出，开始自动登录');
		performAutoLogin();
	}
	function waitForElement(tag, text, timeout, onFound, onTimeout) {
		const start = Date.now();
		const check = () => {
			if (!loginMonitorRunning) return;
			const els = document.querySelectorAll(tag);
			for (const el of els) {
				if ((el.textContent || '').includes(text)) {
					onFound && onFound();
					return;
				}
			}
			if (Date.now() - start < timeout) {
				setTimeout(check, 200);
			} else {
				onTimeout && onTimeout();
			}
		};
		check();
	}

	let loginMonitorDailyRewardTimer = null;
	let loginMonitorNextDailyRewardTime = null;
	let loginMonitorRewardProcessing = false;
	let loginMonitorDailyRewardPopupTimer = null;

	function startDailyLoginReward() {
		if (loginMonitorDailyRewardTimer) return;
		// 安排今天 08:10-08:15 随机时间
		scheduleDailyReward();
		// 每 30 秒检查：到点主动领取；其余时间检测黄色按钮
		loginMonitorDailyRewardTimer = setInterval(dailyRewardTick, 30000);
		// 监控自动弹出的每日奖励页面
		startDailyRewardPopupWatcher();
	}

	function scheduleDailyReward() {
		// 每天 08:10:00 - 08:15:00 随机一个时间
		const now = new Date();
		const target = new Date(now);
		target.setHours(8, 10 + Math.floor(Math.random() * 6), 0, 0);
		if (target <= now) {
			target.setDate(target.getDate() + 1);
		}
		loginMonitorNextDailyRewardTime = target;
		console.log(`[奖励] 已安排每日奖励领取时间：${target.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
	}

	function dailyRewardTick() {
		if (!loginMonitorRunning) return;
		// 仅在已登录状态下执行
		if (isLoggedOut()) return;
		if (loginMonitorRewardProcessing) return;

		// 到点主动触发
		if (loginMonitorNextDailyRewardTime && Date.now() >= loginMonitorNextDailyRewardTime.getTime()) {
			console.log('[奖励] 到达每日奖励领取时间');
			doDailyReward(() => {
				scheduleDailyReward();
			});
			return;
		}

		// 其余时间：检测黄色入口按钮，若存在则领取
		const entryBtn = findDailyRewardButton();
		if (entryBtn && isYellowEntry(entryBtn)) {
			console.log('[奖励] 检测到黄色入口按钮，执行领取');
			doDailyReward();
		}
	}

	// 查找「每日登录奖励」入口按钮（按 title 或文本精确「每日」判断，兼容汉化）
	function findDailyRewardButton() {
		const buttons = document.querySelectorAll('button');
		for (const btn of buttons) {
			const title = (btn.title || '').trim().toLowerCase();
			const txt = (btn.textContent || '').trim();
			const titleMatch = title.includes('daily login reward') || title.includes('每日登录奖励');
			const textMatch = txt === '每日';
			if (titleMatch || textMatch) {
				const rect = btn.getBoundingClientRect();
				const style = getComputedStyle(btn);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					return btn;
				}
			}
		}
		return null;
	}

	// 判断入口按钮是否为黄色（未领取）
	function isYellowEntry(btn) {
		const cls = btn.className || '';
		return cls.includes('bg-yellow');
	}

	function doDailyReward(onDone) {
		// 仅在已登录状态下执行
		if (isLoggedOut()) {
			console.log('[奖励] 未登录，跳过每日奖励领取');
			onDone && onDone();
			return;
		}
		loginMonitorRewardProcessing = true;

		try {
			// 如果每日奖励页面已经自动打开，直接处理领取，不再点击入口按钮
			if (findRewardPanelTitle()) {
				console.log('[奖励] 每日奖励页面已打开，直接处理领取');
				waitForRewardContent(0, onDone);
				return;
			}

			const entryBtn = findDailyRewardButton();
			if (!entryBtn) {
				console.log('[奖励] 未找到每日登录奖励入口按钮');
				loginMonitorRewardProcessing = false;
				onDone && onDone();
				return;
			}

			entryBtn.click();
			console.log('[奖励] 已点击「每日」入口按钮');

			waitForElement(
				'h2', '每日登录奖励', 10000,
				() => {
					waitForRewardContent(0, onDone);
				},
				() => {
					console.warn('[奖励] 未出现「每日登录奖励」面板，主动关闭面板');
					closeRewardPanel(() => {
						loginMonitorRewardProcessing = false;
						onDone && onDone();
					});
				}
			);
		} catch (e) {
			console.error('[奖励] 执行出错:', e);
			loginMonitorRewardProcessing = false;
			onDone && onDone();
		}
	}

	// 等待每日奖励面板内的领取按钮或已领取提示渲染
	function waitForRewardContent(attempts, onDone) {
		// 最多等待 10 秒（20 次 × 500ms）
		if (attempts > 20) {
			console.warn('[奖励] 等待领取按钮/已领取提示超时，主动关闭面板');
			closeRewardPanel(() => {
				sendRewardMessage('failed');
				loginMonitorRewardProcessing = false;
				onDone && onDone();
			});
			return;
		}

		// 已领取提示
		if (findComeBackTomorrowText()) {
			console.log('[奖励] 检测到已领取提示，每日奖励已领取');
			closeRewardPanel(() => {
				sendRewardMessage('already');
				loginMonitorRewardProcessing = false;
				onDone && onDone();
			});
			return;
		}

		// 领取按钮
		const claimBtn = findClaimButton();
		if (claimBtn) {
			const claimText = (claimBtn.textContent || '').trim();
			console.log(`[奖励] 点击领取按钮：${claimText}`);
			claimBtn.click();

			let clickAttempts = 0;
			const checkClaimed = () => {
				clickAttempts++;
				const btn = findClaimButton();
				if (!btn) {
					console.log('[奖励] ✅ 领取按钮已消失，领取成功');
					closeRewardPanel(() => {
						sendRewardMessage('claimed');
						loginMonitorRewardProcessing = false;
						onDone && onDone();
					});
					return;
				}
				if (clickAttempts <= 5) {
					console.log(`[奖励] 领取按钮仍存在，重试 ${clickAttempts} 次`);
					btn.click();
					setTimeout(checkClaimed, 800);
				} else {
					console.log('[奖励] 领取多次失败，停止本次操作');
					closeRewardPanel(() => {
						sendRewardMessage('failed');
						loginMonitorRewardProcessing = false;
						onDone && onDone();
					});
				}
			};
			setTimeout(checkClaimed, 800);
			return;
		}

		// 两者都未出现，继续等待
		setTimeout(() => waitForRewardContent(attempts + 1, onDone), 500);
	}

	// 查找「每日登录奖励」页面标题（用于检测自动弹出的面板）
	function findRewardPanelTitle() {
		const h2s = document.querySelectorAll('h2');
		for (const h2 of h2s) {
			const text = (h2.textContent || '').trim();
			if (text.includes('每日登录奖励')) {
				const rect = h2.getBoundingClientRect();
				const style = getComputedStyle(h2);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					return h2;
				}
			}
		}
		return null;
	}

	// 监控自动弹出的每日奖励页面
	function startDailyRewardPopupWatcher() {
		// 每 2 秒检测一次
		loginMonitorDailyRewardPopupTimer = setInterval(checkDailyRewardPopup, 2000);
	}

	function checkDailyRewardPopup() {
		if (!loginMonitorRunning) return;
		// 仅在已登录状态下执行
		if (isLoggedOut()) return;
		if (loginMonitorRewardProcessing) return;

		// 检测每日奖励页面标题是否出现（面板已自动打开）
		if (!findRewardPanelTitle()) return;

		console.log('[奖励] 检测到每日奖励页面自动弹出');
		loginMonitorRewardProcessing = true;
		waitForRewardContent(0, null);
	}

	// 判断每日奖励是否已领取（出现 "Come back tomorrow" 提示）
	function findComeBackTomorrowText() {
		const divs = document.querySelectorAll('div');
		for (const div of divs) {
			const text = (div.textContent || '').trim().toLowerCase();
			if (text.includes('come back tomorrow')) {
				const rect = div.getBoundingClientRect();
				const style = getComputedStyle(div);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					return div;
				}
			}
		}
		return null;
	}

	// 查找「领取第 X 天奖励」按钮（按包含「领取」且含「奖励」判断）
	function findClaimButton() {
		const buttons = document.querySelectorAll('button');
		for (const btn of buttons) {
			const txt = (btn.textContent || '').trim();
			if (txt.includes('领取') && txt.includes('奖励')) {
				const rect = btn.getBoundingClientRect();
				const style = getComputedStyle(btn);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					return btn;
				}
			}
		}
		return null;
	}

	// 关闭每日奖励面板（点击 × 按钮）
	function closeRewardPanel(onDone) {
		const allButtons = document.querySelectorAll('button');
		for (const btn of allButtons) {
			const txt = (btn.textContent || '').trim();
			if (txt.includes('×')) {
				const rect = btn.getBoundingClientRect();
				const style = getComputedStyle(btn);
				if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
					btn.click();
					console.log('[奖励] 已点击 × 关闭面板');
					if (onDone) setTimeout(onDone, 500);
					return;
				}
			}
		}
		console.warn('[奖励] 未找到关闭按钮，跳过关闭');
		if (onDone) onDone();
	}

	// 推送每日奖励结果微信消息
	function sendRewardMessage(type) {
		const botKey = loginMonitorSettings.botKey;
		if (!botKey) return;
		let msg;
		if (type === 'claimed') {
			msg = formatBotMessage('✅ 每日奖励领取成功');
		} else if (type === 'already') {
			msg = formatBotMessage('✅ 每日奖励已领取');
		} else {
			msg = formatBotMessage('⚠️ 每日奖励领取失败，请手动处理');
		}
		sendWxBot(botKey, msg);
		console.log(`[奖励] 已推送每日奖励消息：${type}`);
	}
	function stopDailyLoginReward() {
		if (loginMonitorDailyRewardTimer) {
			clearInterval(loginMonitorDailyRewardTimer);
			loginMonitorDailyRewardTimer = null;
		}
		if (loginMonitorDailyRewardPopupTimer) {
			clearInterval(loginMonitorDailyRewardPopupTimer);
			loginMonitorDailyRewardPopupTimer = null;
		}
		loginMonitorRewardProcessing = false;
	}

	function startLoginMonitor() {
		if (loginMonitorRunning) return;
		loginMonitorRunning = true;
		loginMonitorLoggingIn = false;
		setLoginMonitorStatus("监控中");
		console.log("[监控登录] 监控已启动");
		startCheckFromPlay();
		checkAndLogin();
		startDailyLoginReward();
	}
	function stopLoginMonitor() {
		loginMonitorRunning = false;
		loginMonitorLoggingIn = false;
		stopDailyLoginReward();
		setLoginMonitorStatus("未监控");
		console.log("[监控登录] 监控已关闭");
	}
	function createPanelController({ actions, getState }) {
		let panelCollapsed = loadPanelCollapsed();
		let panelView = "control";
		let earningsBiomeFilter = "current";
		let earningsBaitFilter = "current";
		let autoBaitPurchaseSaveTimer = null;
		let autoBaitPurchaseSettingsDirty = false;
		let draggedAutoBiomePriorityId = null;
		let ui = null;
		const { resetEarningsStats, setAutoBaitGrade, setAutoBaitPurchaseSettings, setAutoBiomeMasteryXpBonusEnabled, setAutoBiomeMaxBiome, setAutoBiomePriorityOrder, setAutoBiomeWeight, setCaptchaBypassEnabled, setClickDelaySetting, setEnabled, setGameAutoFishingEnabled, setLoginMonitorEnabled, setLoginMonitorConfig } = actions;
		function normalizeText(text) {
			return String(text ?? "").replace(/\s+/g, " ").trim();
		}
		function toFiniteNumber(value) {
			const number = Number(value);
			return Number.isFinite(number) ? number : 0;
		}
		function flushAutoBaitPurchaseSettings() {
			window.clearTimeout(autoBaitPurchaseSaveTimer);
			autoBaitPurchaseSaveTimer = null;
			if (!autoBaitPurchaseSettingsDirty || !ui) return;
			autoBaitPurchaseSettingsDirty = false;
			setAutoBaitPurchaseSettings({
				minimumQuantity: ui.autoBaitMinimumQuantity.value,
				purchaseQuantity: ui.autoBaitPurchaseQuantity.value
			});
		}
		function scheduleAutoBaitPurchaseSettingsSave() {
			autoBaitPurchaseSettingsDirty = true;
			window.clearTimeout(autoBaitPurchaseSaveTimer);
			autoBaitPurchaseSaveTimer = null;
			const minimumQuantity = Number(ui?.autoBaitMinimumQuantity.value);
			if (!Number.isFinite(minimumQuantity) || minimumQuantity < 1 || minimumQuantity > 1e5) return;
			autoBaitPurchaseSaveTimer = window.setTimeout(flushAutoBaitPurchaseSettings, 300);
		}
		function getAutoBiomePriorityOrderFromUi() {
			return Array.from(ui?.autoBiomePriorityList?.children ?? [], (item) => item.getAttribute("data-priority-id"));
		}
		function commitAutoBiomePriorityOrder() {
			setAutoBiomePriorityOrder(getAutoBiomePriorityOrderFromUi());
		}
		function moveAutoBiomePriorityItem(item, direction) {
			const sibling = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
			if (!sibling) return;
			if (direction < 0) item.parentElement.insertBefore(item, sibling);
			else item.parentElement.insertBefore(sibling, item);
			commitAutoBiomePriorityOrder();
		}
		function createPanel() {
			if (document.getElementById("arcane-angler-cast-panel-host")) return;
			const host = document.createElement("div");
			host.id = PANEL_ID;
			host.style.cssText = [
				"position: fixed",
				"right: 16px",
				"bottom: 16px",
				"z-index: 2147483647",
				"font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
			].join(";");
			const shadowRoot = host.attachShadow({ mode: "open" });
			const baitGradeOptions = `
              <option value="default">默认饵（无限，不购买）</option>
              <option value="low">低级饵</option>
              <option value="medium">中级饵（+250 幸运）</option>
              <option value="high">高级饵（+500 幸运）</option>
              <option value="super">超级饵（+1000 幸运）</option>
        `;
			shadowRoot.innerHTML = `
  <style>${panel_default}</style>

  <div class="panel">
    <div class="header">
      <div class="title">
        <span aria-hidden="true">🎣</span>
        <span class="title-text">自动抛竿</span>
      </div>

      <button
        id="collapse-toggle"
        class="collapse-toggle"
        type="button"
        aria-controls="panel-content"
      >−</button>
    </div>

    <div id="panel-content" class="panel-content">
      <div class="tabs" role="tablist" aria-label="面板内容">
        <button
          id="control-tab"
          class="panel-tab"
          type="button"
          role="tab"
          aria-controls="control-view"
          aria-selected="true"
          data-active="true"
        >控制</button>
        <button
          id="earnings-tab"
          class="panel-tab"
          type="button"
          role="tab"
          aria-controls="earnings-view"
          aria-selected="false"
          data-active="false"
        >收益</button>
        <button
          id="settings-tab"
          class="panel-tab"
          type="button"
          role="tab"
          aria-controls="settings-view"
          aria-selected="false"
          data-active="false"
        >设置</button>
      </div>

      <div
        id="control-view"
        class="panel-view"
        role="tabpanel"
        aria-labelledby="control-tab"
      >

        <div class="row">
          <span class="label">状态</span>
          <span id="status" class="value">初始化中</span>
        </div>

        <div class="row">
          <span class="label">下一操作</span>
          <span id="next-delay" class="value">—</span>
        </div>

        <div class="row">
          <span class="label">点击次数</span>
          <span id="click-count" class="value">0</span>
        </div>

        <div class="row">
          <span class="label">内置钓鱼</span>
          <span id="game-auto-fishing-status" class="value">未启用</span>
        </div>

        <div class="row">
          <span class="label">选图状态</span>
          <span id="auto-biome-status" class="value">等待天气数据</span>
        </div>

        <div class="row">
          <span class="label">鱼饵状态</span>
          <span id="auto-bait-status" class="value">未启用</span>
        </div>

        <div class="row">
          <span class="label">Boss 状态</span>
          <span id="auto-boss-status" class="value">未启用</span>
        </div>

        <label class='option-row'>
          <span>使用内置自动钓鱼</span>
          <span class='switch'>
            <input
              id='game-auto-fishing-toggle'
              type='checkbox'
              role='switch'
              aria-label='使用内置自动钓鱼'
            />
            <span class='switch-track' aria-hidden='true'></span>
          </span>
        </label>

        <label class="option-row">
          <span>自动过验证</span>
          <span class="switch">
            <input
              id="captcha-bypass-toggle"
              type="checkbox"
              role="switch"
              aria-label="自动过验证"
            />
            <span class="switch-track" aria-hidden="true"></span>
          </span>
        </label>

        <button
          id="export-fish-image"
          class="toggle"
          type="button"
          style="background: #38a169;"
        >
          导出换鱼助手
        </button>

        <button id="toggle" class="toggle" type="button">
          启动
        </button>

      </div>

      <div
        id="earnings-view"
        class="panel-view"
        role="tabpanel"
        aria-labelledby="earnings-tab"
        hidden
      >
        <div class="stats-filters">
          <label class="stats-filter">
            <span>地图范围</span>
            <select id="stats-biome-filter" class="stats-select"></select>
          </label>
          <label class="stats-filter">
            <span>鱼饵范围</span>
            <select id="stats-bait-filter" class="stats-select"></select>
          </label>
        </div>

        <div id="stats-scope" class="stats-scope">—</div>
        <div id="stats-start" class="stats-start">—</div>

        <div class="stats-grid">
          <div class="stat-card">
            <span class="stat-card-label">成功抛竿</span>
            <strong id="stats-casts" class="stat-card-value">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">鱼获</span>
            <strong id="stats-fish" class="stat-card-value">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">直接金币</span>
            <strong
              id="stats-gold"
              class="stat-card-value"
              data-tone="income"
            >0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">鱼获价值</span>
            <strong
              id="stats-fish-gold"
              class="stat-card-value"
              data-tone="gold"
            >0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">鱼饵成本</span>
            <strong
              id="stats-bait-cost"
              class="stat-card-value"
              data-tone="cost"
            >0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">净收益</span>
            <strong
              id="stats-net-gold"
              class="stat-card-value"
              data-tone="neutral"
            >0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">经验</span>
            <strong id="stats-xp" class="stat-card-value">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">遗物</span>
            <strong id="stats-relics" class="stat-card-value">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">宝箱</span>
            <strong id="stats-treasures" class="stat-card-value">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">装备</span>
            <strong id="stats-gears" class="stat-card-value">0</strong>
          </div>
          <div class="stat-card">
            <span class="stat-card-label">每竿净收益</span>
            <strong
              id="stats-net-average"
              class="stat-card-value"
              data-tone="neutral"
            >0</strong>
          </div>
        </div>

        <div id="stats-cost-note" class="stats-cost-note" hidden></div>

        <div class="stats-section-title">收获分类</div>
        <div id="rarity-stats" class="stats-list"></div>

        <button id="reset-stats" class="reset-stats" type="button">
          重置收益统计
        </button>
      </div>

      <div
        id="settings-view"
        class="panel-view"
        role="tabpanel"
        aria-labelledby="settings-tab"
        hidden
      >
        <details class='settings-section'>
          <summary class='settings-title'>自动出售鱼</summary>

          <div class='field-help'>
            将背包中稀有度为传奇的鱼按“基础价 × 泰坦数值”向上取整到万位后自动挂单出售，出售数量为该鱼的持有数量。
          </div>

          <div class='field'>
            <span class='field-label'>出售状态</span>
            <span id='auto-sell-status' class='value' style='text-align: left;'>未出售</span>
          </div>

          <button id='sell-legendary-fish' class='toggle' type='button' style='background: #f59e0b; color: #1a202c;'>
            出售传奇鱼
          </button>
          <button id='sell-mythic-fish' class='toggle' type='button' style='background: #ef4444; color: #ffffff;'>
            出售神话鱼
          </button>
        </details>

        <details class='settings-section'>
          <summary class='settings-title'>换鱼助手</summary>

          <div class='field-help'>
            将背包以及“交易 → 出售列表 → 我的上架”中的奇异鱼复制到剪贴板，可直接粘贴发给别人换鱼。
          </div>

          <button id='export-exotic-fish-zh' class='toggle' type='button'>
            导出已有奇异（中）
          </button>
          <button id='export-exotic-fish-en' class='toggle' type='button'>
            导出已有奇异（英）
          </button>
        </details>

        <details class="settings-section">
          <summary class="settings-title">自动买鱼饵</summary>

          <label class='field'>
            <span class='field-label'>选择鱼饵</span>
            <select id='auto-bait-grade' class='input'>
              ${baitGradeOptions}
            </select>
          </label>

          <div id="auto-bait-purchase-settings" class="settings-group">
            <div class="number-grid">
              <label class="field">
                <span class="field-label">库存低于</span>
                <input
                  id="auto-bait-minimum-quantity"
                  class="input"
                  type="number"
                  min="1"
                  max="100000"
                  step="1"
                  inputmode="numeric"
                />
              </label>

              <label class="field">
                <span class="field-label">每次购买</span>
                <select id="auto-bait-purchase-quantity" class="input">
                  <option value="100">100 个</option>
                  <option value="1000">1000 个</option>
                </select>
              </label>
            </div>

            <div class="field-help">
            统一使用所选鱼饵；默认饵无限不购买，付费鱼饵库存低于设置值时自动购买，阈值按 100 的倍数保存。
            </div>
          </div>

          <div class="row">
            <span class="label">上次购买</span>
            <span id="auto-bait-last-purchased-at" class="value">暂无</span>
          </div>
        </details>

        <details class="settings-section">
          <summary class="settings-title">实时监控</summary>

          <label class="option-row">
            <span>启用登录情况监控</span>
            <span class="switch">
              <input
                id="login-monitor-toggle"
                type="checkbox"
                role="switch"
                aria-label="启用登录情况监控"
              />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>

          <label class="option-row">
            <span>稀有掉落通知</span>
            <span class="switch">
              <input
                id="login-monitor-rare-drop-notify-toggle"
                type="checkbox"
                role="switch"
                aria-label="稀有掉落通知"
              />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>

          <label class="field">
            <span class="field-label">机器名</span>
            <input
              id="login-monitor-machine-name"
              class="input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="如：服务器A"
            />
          </label>

          <label class="field">
            <span class="field-label">微信机器人 Key</span>
            <input
              id="login-monitor-bot-key"
              class="input"
              type="password"
              autocomplete="off"
              spellcheck="false"
              placeholder="请输入微信机器人 key"
            />
          </label>

          <label class="field">
            <span class="field-label">登录账号</span>
            <input
              id="login-monitor-username"
              class="input"
              type="text"
              autocomplete="username"
              placeholder="请输入登录账号"
            />
          </label>

          <label class="field">
            <span class="field-label">登录密码</span>
            <input
              id="login-monitor-password"
              class="input"
              type="password"
              autocomplete="current-password"
              placeholder="请输入登录密码"
            />
          </label>

          <div class="row">
            <span class="label">监控状态</span>
            <span id="login-monitor-status" class="value">未监控</span>
          </div>

          <div class="field-help">
            开启后，脚本会检测网页是否登出；登出时自动使用上方账号密码重新登录，并通过微信机器人推送登出与登录结果。
          </div>
        </details>

        <details class="settings-section">
          <summary class="settings-title">自动换地图</summary>

          <label class="field">
            <span class="field-label">最大生态区域</span>
            <select id="auto-biome-max-biome" class="input"></select>
          </label>

          <div class="field-help">
            选图时仅在生态区域 1 到该编号范围内选择；选“不限”则使用全部已解锁区域。
          </div>

          <div class="field-label priority-heading">选图优先级</div>

          <div
            id="auto-biome-priority-list"
            class="priority-list"
            role="list"
            aria-label="自动换图优先级，可拖动排序"
          >
            ${AUTO_BIOME_PRIORITY_OPTIONS.map(({ id, label }) => `
              <div
                class="priority-item"
                data-priority-id="${id}"
                draggable="true"
                role="listitem"
              >
                <span class="priority-drag-handle" aria-hidden="true">⠿</span>
                <span class="priority-label">${label}</span>
                <span class="priority-state"></span>
                <span class="priority-actions">
                  <button
                    class="priority-move"
                    type="button"
                    data-direction="-1"
                    aria-label="上移${label}"
                    title="上移"
                  >↑</button>
                  <button
                    class="priority-move"
                    type="button"
                    data-direction="1"
                    aria-label="下移${label}"
                    title="下移"
                  >↓</button>
                </span>
              </div>
            `).join("")}
          </div>

          <div class="field-help">
            拖动列表调整顺序；也可使用右侧箭头。排在“加权经验对比”下面的项目视为未启用。
          </div>

          <div
            class="choice-list choice-list-three"
            role="radiogroup"
            aria-label="地图等级加权量"
          >
            <label class="choice-option">
              <input
                type="radio"
                name="auto-biome-weight"
                value="0"
              />
              <span>0%</span>
            </label>
            <label class="choice-option">
              <input
                type="radio"
                name="auto-biome-weight"
                value="5"
              />
              <span>5%</span>
            </label>
            <label class="choice-option">
              <input
                type="radio"
                name="auto-biome-weight"
                value="10"
              />
              <span>10%</span>
            </label>
          </div>

          <div class="field-help">
            加权经验评分 = 天气经验加成 + 公会经验加成 + 可选地图精通加成 +（地图编号 - 1）× 加权量；同分时选择编号最高的已解锁地图。
          </div>

          <label class="option-row">
            <span>评分计入地图精通加成</span>
            <span class="switch">
              <input
                id="auto-biome-mastery-xp-bonus-toggle"
                type="checkbox"
                role="switch"
                aria-label="评分计入地图精通加成"
              />
              <span class="switch-track" aria-hidden="true"></span>
            </span>
          </label>

          <div class="field-help">
            关闭后选图不计个人地图精通，适合船长按全队共同加成选图。
          </div>

          <div class="row">
            <span class="label">比赛地图</span>
            <span id="auto-biome-competition-status" class="value">自动换图开启后检测</span>
          </div>

          <div class="row">
            <span class="label">每日任务</span>
            <span id="auto-biome-daily-quest-status" class="value">自动换图开启后读取</span>
          </div>

          <div class="row">
            <span class="label">天气更新</span>
            <span id="auto-biome-updated-at" class="value">等待接口数据</span>
          </div>
        </details>

        <details class="settings-section">
          <summary class="settings-title">过验证记录</summary>

          <div
            id="verification-history"
            class="verification-history"
            aria-live="polite"
          ></div>

          <div class="field-help">
            记录最近 5 次自动验证完成时间和结果，刷新页面后仍会保留。
          </div>
        </details>

        <details class="settings-section">
          <summary class="settings-title">自动点击间隔</summary>

          <div class="number-grid">
            <label class="field">
              <span class="field-label">小间隔最短（秒）</span>
              <input
                id="short-delay-min-seconds"
                class="input"
                type="number"
                min="0.1"
                max="3600"
                step="0.1"
                inputmode="decimal"
              />
            </label>

            <label class="field">
              <span class="field-label">小间隔最长（秒）</span>
              <input
                id="short-delay-max-seconds"
                class="input"
                type="number"
                min="0.1"
                max="3600"
                step="0.1"
                inputmode="decimal"
              />
            </label>

            <label class="field">
              <span class="field-label">大间隔最短（秒）</span>
              <input
                id="long-delay-min-seconds"
                class="input"
                type="number"
                min="0.1"
                max="3600"
                step="0.1"
                inputmode="decimal"
              />
            </label>

            <label class="field">
              <span class="field-label">大间隔最长（秒）</span>
              <input
                id="long-delay-max-seconds"
                class="input"
                type="number"
                min="0.1"
                max="3600"
                step="0.1"
                inputmode="decimal"
              />
            </label>
          </div>

          <label class="field">
            <span class="field-label">大间隔概率（%）</span>
            <input
              id="long-delay-chance-percent"
              class="input"
              type="number"
              min="0"
              max="100"
              step="0.1"
              inputmode="decimal"
            />
          </label>

          <div class="field-help">
            每次自动点击前先按概率选择大间隔或小间隔，再在对应的最短与最长时间内随机等待。
          </div>
        </details>

      </div>
    </div>
  </div>
`;
			document.body.appendChild(host);
			ui = {
				panel: shadowRoot.querySelector(".panel"),
				status: shadowRoot.querySelector("#status"),
				nextDelay: shadowRoot.querySelector("#next-delay"),
				clickCount: shadowRoot.querySelector("#click-count"),
				gameAutoFishingStatus: shadowRoot.querySelector("#game-auto-fishing-status"),
				gameAutoFishingToggle: shadowRoot.querySelector("#game-auto-fishing-toggle"),
				shortDelayMinSeconds: shadowRoot.querySelector("#short-delay-min-seconds"),
				shortDelayMaxSeconds: shadowRoot.querySelector("#short-delay-max-seconds"),
				longDelayMinSeconds: shadowRoot.querySelector("#long-delay-min-seconds"),
				longDelayMaxSeconds: shadowRoot.querySelector("#long-delay-max-seconds"),
				longDelayChancePercent: shadowRoot.querySelector("#long-delay-chance-percent"),
				autoBiomeStatus: shadowRoot.querySelector("#auto-biome-status"),
				autoBiomePriorityList: shadowRoot.querySelector("#auto-biome-priority-list"),
				autoBiomePriorityItems: shadowRoot.querySelectorAll("#auto-biome-priority-list .priority-item"),
				autoBiomeCompetitionStatus: shadowRoot.querySelector("#auto-biome-competition-status"),
				autoBiomeDailyQuestStatus: shadowRoot.querySelector("#auto-biome-daily-quest-status"),
				autoBiomeWeightInputs: shadowRoot.querySelectorAll("input[name=\"auto-biome-weight\"]"),
				autoBiomeMasteryXpBonusToggle: shadowRoot.querySelector("#auto-biome-mastery-xp-bonus-toggle"),
				autoBiomeMaxBiome: shadowRoot.querySelector("#auto-biome-max-biome"),
				autoBiomeUpdatedAt: shadowRoot.querySelector("#auto-biome-updated-at"),
				autoBaitStatus: shadowRoot.querySelector("#auto-bait-status"),
				autoBossStatus: shadowRoot.querySelector("#auto-boss-status"),
				autoBaitGrade: shadowRoot.querySelector('#auto-bait-grade'),
				autoBaitPurchaseSettings: shadowRoot.querySelector("#auto-bait-purchase-settings"),
				autoBaitMinimumQuantity: shadowRoot.querySelector("#auto-bait-minimum-quantity"),
				autoBaitPurchaseQuantity: shadowRoot.querySelector("#auto-bait-purchase-quantity"),
				autoBaitLastPurchasedAt: shadowRoot.querySelector("#auto-bait-last-purchased-at"),
				captchaBypassToggle: shadowRoot.querySelector("#captcha-bypass-toggle"),
				verificationHistory: shadowRoot.querySelector("#verification-history"),
				controlTab: shadowRoot.querySelector("#control-tab"),
				earningsTab: shadowRoot.querySelector("#earnings-tab"),
				settingsTab: shadowRoot.querySelector("#settings-tab"),
				controlView: shadowRoot.querySelector("#control-view"),
				earningsView: shadowRoot.querySelector("#earnings-view"),
				settingsView: shadowRoot.querySelector("#settings-view"),
				statsBiomeFilter: shadowRoot.querySelector("#stats-biome-filter"),
				statsBaitFilter: shadowRoot.querySelector("#stats-bait-filter"),
				statsScope: shadowRoot.querySelector("#stats-scope"),
				statsStart: shadowRoot.querySelector("#stats-start"),
				statsCasts: shadowRoot.querySelector("#stats-casts"),
				statsFish: shadowRoot.querySelector("#stats-fish"),
				statsGold: shadowRoot.querySelector("#stats-gold"),
				statsFishGold: shadowRoot.querySelector("#stats-fish-gold"),
				statsBaitCost: shadowRoot.querySelector("#stats-bait-cost"),
				statsNetGold: shadowRoot.querySelector("#stats-net-gold"),
				statsXp: shadowRoot.querySelector("#stats-xp"),
				statsRelics: shadowRoot.querySelector("#stats-relics"),
				statsTreasures: shadowRoot.querySelector("#stats-treasures"),
				statsGears: shadowRoot.querySelector("#stats-gears"),
				statsNetAverage: shadowRoot.querySelector("#stats-net-average"),
				statsCostNote: shadowRoot.querySelector("#stats-cost-note"),
				rarityStats: shadowRoot.querySelector("#rarity-stats"),
				resetStats: shadowRoot.querySelector("#reset-stats"),
				collapseToggle: shadowRoot.querySelector("#collapse-toggle"),
				toggle: shadowRoot.querySelector("#toggle"),
				exportFishImage: shadowRoot.querySelector("#export-fish-image"),
				exportExoticFishZh: shadowRoot.querySelector('#export-exotic-fish-zh'),
				exportExoticFishEn: shadowRoot.querySelector('#export-exotic-fish-en'),
				sellLegendaryFish: shadowRoot.querySelector('#sell-legendary-fish'),
				autoSellStatus: shadowRoot.querySelector('#auto-sell-status'),
				sellMythicFish: shadowRoot.querySelector('#sell-mythic-fish'),
				loginMonitorToggle: shadowRoot.querySelector("#login-monitor-toggle"),
				loginMonitorMachineName: shadowRoot.querySelector("#login-monitor-machine-name"),
				loginMonitorBotKey: shadowRoot.querySelector("#login-monitor-bot-key"),
				loginMonitorUsername: shadowRoot.querySelector("#login-monitor-username"),
				loginMonitorPassword: shadowRoot.querySelector("#login-monitor-password"),
				loginMonitorStatus: shadowRoot.querySelector("#login-monitor-status"),
				loginMonitorRareDropNotifyToggle: shadowRoot.querySelector("#login-monitor-rare-drop-notify-toggle")
			};
			ui.collapseToggle.addEventListener("click", () => {
				setPanelCollapsed(!panelCollapsed);
			});
			ui.toggle.addEventListener("click", () => {
				setEnabled(!getState().enabled);
			});
			ui.exportFishImage.addEventListener("click", () => {
				if (ui.exportFishImage.disabled) return;
				ui.exportFishImage.disabled = true;
				ui.exportFishImage.textContent = "正在导出...";
				exportFishImageData().finally(() => {
					ui.exportFishImage.disabled = false;
					ui.exportFishImage.textContent = "导出换鱼助手";
				});
			});
			ui.exportExoticFishZh.addEventListener('click', () => {
				if (ui.exportExoticFishZh.disabled) return;
				ui.exportExoticFishZh.disabled = true;
				ui.exportExoticFishZh.textContent = '正在导出...';
				exportOwnedExoticFish('zh').finally(() => {
					ui.exportExoticFishZh.disabled = false;
					ui.exportExoticFishZh.textContent = '导出已有奇异（中）';
				});
			});
			ui.exportExoticFishEn.addEventListener('click', () => {
				if (ui.exportExoticFishEn.disabled) return;
				ui.exportExoticFishEn.disabled = true;
				ui.exportExoticFishEn.textContent = '正在导出...';
				exportOwnedExoticFish('en').finally(() => {
					ui.exportExoticFishEn.disabled = false;
					ui.exportExoticFishEn.textContent = '导出已有奇异（英）';
				});
			});
			ui.sellLegendaryFish.addEventListener('click', () => {
				if (ui.sellLegendaryFish.disabled) return;
				ui.sellLegendaryFish.disabled = true;
				ui.sellLegendaryFish.textContent = '正在出售传奇鱼';
				autoSellFish('Legendary').finally(() => {
					ui.sellLegendaryFish.disabled = false;
					ui.sellLegendaryFish.textContent = '出售传奇鱼';
				});
			});
			ui.sellMythicFish.addEventListener('click', () => {
				if (ui.sellMythicFish.disabled) return;
				ui.sellMythicFish.disabled = true;
				ui.sellMythicFish.textContent = '正在出售神话鱼';
				autoSellFish('Mythic').finally(() => {
					ui.sellMythicFish.disabled = false;
					ui.sellMythicFish.textContent = '出售神话鱼';
				});
			});
			ui.gameAutoFishingToggle.addEventListener("change", (event) => {
				setGameAutoFishingEnabled(event.currentTarget.checked);
			});
			ui.captchaBypassToggle.addEventListener("change", (event) => {
				setCaptchaBypassEnabled(event.currentTarget.checked);
			});
			ui.autoBiomeMasteryXpBonusToggle.addEventListener("change", (event) => {
				setAutoBiomeMasteryXpBonusEnabled(event.currentTarget.checked);
			});
			ui.autoBiomeMaxBiome.addEventListener("change", (event) => {
				setAutoBiomeMaxBiome(event.currentTarget.value);
			});
			ui.autoBiomePriorityList.addEventListener("dragstart", (event) => {
				const item = event.target.closest(".priority-item");
				if (!item) return;
				draggedAutoBiomePriorityId = item.getAttribute("data-priority-id");
				item.setAttribute("data-dragging", "true");
				event.dataTransfer?.setData("text/plain", draggedAutoBiomePriorityId);
				if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			});
			ui.autoBiomePriorityList.addEventListener("dragover", (event) => {
				const targetItem = event.target.closest(".priority-item");
				const draggedItem = ui.autoBiomePriorityList.querySelector(`[data-priority-id="${draggedAutoBiomePriorityId}"]`);
				if (!targetItem || !draggedItem || targetItem === draggedItem) return;
				event.preventDefault();
				const targetRect = targetItem.getBoundingClientRect();
				const insertBefore = event.clientY < targetRect.top + targetRect.height / 2;
				ui.autoBiomePriorityList.insertBefore(draggedItem, insertBefore ? targetItem : targetItem.nextElementSibling);
			});
			ui.autoBiomePriorityList.addEventListener("drop", (event) => {
				event.preventDefault();
			});
			ui.autoBiomePriorityList.addEventListener("dragend", (event) => {
				event.target.closest(".priority-item")?.removeAttribute("data-dragging");
				draggedAutoBiomePriorityId = null;
				commitAutoBiomePriorityOrder();
			});
			ui.autoBiomePriorityList.addEventListener("click", (event) => {
				const button = event.target.closest(".priority-move");
				const item = button?.closest(".priority-item");
				if (!button || !item) return;
				moveAutoBiomePriorityItem(item, Number(button.getAttribute("data-direction")));
			});
			ui.autoBaitGrade.addEventListener('change', (event) => {
				setAutoBaitGrade(event.currentTarget.value);
			});
			ui.autoBaitMinimumQuantity.addEventListener("input", () => {
				scheduleAutoBaitPurchaseSettingsSave();
			});
			ui.autoBaitMinimumQuantity.addEventListener("change", () => {
				autoBaitPurchaseSettingsDirty = true;
				flushAutoBaitPurchaseSettings();
			});
			ui.autoBaitPurchaseQuantity.addEventListener("change", () => {
				autoBaitPurchaseSettingsDirty = true;
				flushAutoBaitPurchaseSettings();
			});
			for (const [input, field] of [
				[ui.shortDelayMinSeconds, "shortDelayMinSeconds"],
				[ui.shortDelayMaxSeconds, "shortDelayMaxSeconds"],
				[ui.longDelayMinSeconds, "longDelayMinSeconds"],
				[ui.longDelayMaxSeconds, "longDelayMaxSeconds"],
				[ui.longDelayChancePercent, "longDelayChancePercent"]
			]) input.addEventListener("change", (event) => {
				setClickDelaySetting(field, event.currentTarget.value);
			});
			for (const input of ui.autoBiomeWeightInputs) input.addEventListener("change", (event) => {
				if (event.currentTarget.checked) setAutoBiomeWeight(event.currentTarget.value);
			});
			ui.controlTab.addEventListener("click", () => {
				setPanelView("control");
			});
			ui.earningsTab.addEventListener("click", () => {
				setPanelView("earnings");
			});
			ui.settingsTab.addEventListener("click", () => {
				setPanelView("settings");
			});
			ui.loginMonitorToggle.addEventListener("change", (event) => {
				setLoginMonitorEnabled(event.currentTarget.checked);
			});
			ui.loginMonitorMachineName.addEventListener("change", (event) => {
				setLoginMonitorConfig({ machineName: event.currentTarget.value });
			});
			ui.loginMonitorBotKey.addEventListener("change", (event) => {
				setLoginMonitorConfig({ botKey: event.currentTarget.value });
			});
			ui.loginMonitorUsername.addEventListener("change", (event) => {
				setLoginMonitorConfig({ username: event.currentTarget.value });
			});
			ui.loginMonitorPassword.addEventListener("change", (event) => {
				setLoginMonitorConfig({ password: event.currentTarget.value });
			});
			ui.loginMonitorRareDropNotifyToggle.addEventListener("change", (event) => {
				setLoginMonitorConfig({ rareDropNotifyEnabled: event.currentTarget.checked });
			});
			ui.resetStats.addEventListener("click", () => {
				resetEarningsStats();
			});
			ui.statsBiomeFilter.addEventListener("change", (event) => {
				earningsBiomeFilter = event.currentTarget.value;
				earningsBaitFilter = earningsBiomeFilter === "current" ? "current" : "all";
				renderEarningsStats();
			});
			ui.statsBaitFilter.addEventListener("change", (event) => {
				earningsBaitFilter = event.currentTarget.value;
				renderEarningsStats();
			});
			renderToggle();
			renderAutoBaitSettings();
			renderAutoBiomeSettings();
			renderAutoBossSettings();
			renderCaptchaBypassToggle();
			renderVerificationHistory();
			renderClickDelaySettings();
			renderGameAutoFishingSettings();
			renderPanelCollapsed();
			renderLoginMonitorSettings();
			loginMonitorStatusEl = ui.loginMonitorStatus;
			if (loginMonitorStatusEl) loginMonitorStatusEl.textContent = loginMonitorRunning ? "监控中" : "未监控";
			updateClickCount();
			setPanelView(panelView);
			renderEarningsStats();
		}
		function setStatus(text) {
			if (ui?.status) ui.status.textContent = text;
		}
		function setAutoSellStatus(text) {
			if (ui?.autoSellStatus) ui.autoSellStatus.textContent = text;
		}
		function setNextDelay(text) {
			if (ui?.nextDelay) ui.nextDelay.textContent = text;
		}
		function updateClickCount() {
			if (ui?.clickCount) ui.clickCount.textContent = String(getState().clickCount);
		}
		function setPanelView(nextView) {
			panelView = nextView === "earnings" || nextView === "settings" ? nextView : "control";
			if (!ui?.controlTab || !ui?.earningsTab || !ui?.settingsTab || !ui?.controlView || !ui?.earningsView || !ui?.settingsView) return;
			const panelItems = [
				[
					"control",
					ui.controlTab,
					ui.controlView
				],
				[
					"earnings",
					ui.earningsTab,
					ui.earningsView
				],
				[
					"settings",
					ui.settingsTab,
					ui.settingsView
				]
			];
			for (const [view, tab, panel] of panelItems) {
				const active = panelView === view;
				tab.dataset.active = active ? "true" : "false";
				tab.setAttribute("aria-selected", active ? "true" : "false");
				panel.hidden = !active;
			}
			if (panelView === "earnings") renderEarningsStats();
			else if (panelView === "settings") {
				renderAutoBaitSettings();
				renderAutoBiomeSettings();
				renderAutoBossSettings();
				renderClickDelaySettings();
				renderGameAutoFishingSettings();
				renderLoginMonitorSettings();
				renderVerificationHistory();
			}
		}
		function formatStatNumber(value, maximumFractionDigits = 0) {
			return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(toFiniteNumber(value));
		}
		function renderSignedStatTone(element, value) {
			const number = toFiniteNumber(value);
			element.dataset.tone = number > 0 ? "positive" : number < 0 ? "negative" : "neutral";
		}
		function compareDimensionIds(left, right) {
			const leftNumber = Number(left);
			const rightNumber = Number(right);
			if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
			return String(left).localeCompare(String(right));
		}
		function formatBiomeLabel(context) {
			return context.biomeId === "unknown" ? context.biomeName : `[B${context.biomeId}] ${context.biomeName}`;
		}
		function formatBaitLabel(context) {
			const cost = context.baitPrice === null ? "成本未知" : `${formatStatNumber(context.baitPrice, 2)} 金币/竿`;
			return `${context.baitName} · ${cost}`;
		}
		function replaceSelectOptions(select, options, selectedValue) {
			select.replaceChildren();
			for (const optionData of options) {
				const option = document.createElement("option");
				option.value = optionData.value;
				option.textContent = optionData.label;
				option.disabled = Boolean(optionData.disabled);
				select.appendChild(option);
			}
			select.value = options.find((option) => option.value === selectedValue) ? selectedValue : "all";
			return select.value;
		}
		function getResolvedBiomeId(earningsStats) {
			if (earningsBiomeFilter === "current") return earningsStats.lastContext?.biomeId ?? null;
			return earningsBiomeFilter === "all" ? null : earningsBiomeFilter.slice(6);
		}
		function renderEarningsFilters(earningsStats) {
			const breakdowns = listEarningsBreakdowns(earningsStats);
			const currentContext = earningsStats.lastContext;
			const biomeContexts = new Map();
			for (const breakdown of breakdowns) biomeContexts.set(breakdown.biomeId, breakdown);
			if (currentContext) biomeContexts.set(currentContext.biomeId, currentContext);
			const sortedBiomeContexts = [...biomeContexts.values()].sort((left, right) => compareDimensionIds(left.biomeId, right.biomeId));
			const biomeOptions = [
				{
					value: "current",
					label: currentContext ? `当前 · ${formatBiomeLabel(currentContext)}` : "当前地图（等待首次抛竿）",
					disabled: !currentContext
				},
				{
					value: "all",
					label: "全部地图"
				},
				...sortedBiomeContexts.map((context) => ({
					value: `biome:${context.biomeId}`,
					label: formatBiomeLabel(context)
				}))
			];
			earningsBiomeFilter = replaceSelectOptions(ui.statsBiomeFilter, biomeOptions, earningsBiomeFilter);
			const resolvedBiomeId = getResolvedBiomeId(earningsStats);
			const baitContexts = new Map();
			for (const breakdown of breakdowns) {
				if (resolvedBiomeId !== null && breakdown.biomeId !== resolvedBiomeId) continue;
				baitContexts.set(breakdown.baitId, breakdown);
			}
			const currentBaitAvailable = currentContext && (resolvedBiomeId === null || resolvedBiomeId === currentContext.biomeId);
			if (currentBaitAvailable) baitContexts.set(currentContext.baitId, currentContext);
			const sortedBaitContexts = [...baitContexts.values()].sort((left, right) => left.baitName.localeCompare(right.baitName));
			const baitOptions = [
				{
					value: "current",
					label: currentBaitAvailable ? `当前 · ${formatBaitLabel(currentContext)}` : "当前鱼饵（不在所选地图）",
					disabled: !currentBaitAvailable
				},
				{
					value: "all",
					label: "全部鱼饵"
				},
				...sortedBaitContexts.map((context) => ({
					value: `bait:${context.baitId}`,
					label: formatBaitLabel(context)
				}))
			];
			earningsBaitFilter = replaceSelectOptions(ui.statsBaitFilter, baitOptions, earningsBaitFilter);
		}
		function resolveEarningsFilter(earningsStats) {
			const currentContext = earningsStats.lastContext;
			return {
				ready: !(earningsBiomeFilter === "current" && !currentContext) && !(earningsBaitFilter === "current" && !currentContext),
				biomeId: earningsBiomeFilter === "current" ? currentContext?.biomeId : earningsBiomeFilter === "all" ? null : earningsBiomeFilter.slice(6),
				baitId: earningsBaitFilter === "current" ? currentContext?.baitId : earningsBaitFilter === "all" ? null : earningsBaitFilter.slice(5)
			};
		}
		function getEarningsScopeLabel(earningsStats, filter) {
			if (!filter.ready) return "等待首次抛竿确认当前地图和鱼饵";
			const breakdowns = listEarningsBreakdowns(earningsStats);
			const biomeContext = earningsStats.lastContext?.biomeId === filter.biomeId ? earningsStats.lastContext : breakdowns.find((breakdown) => breakdown.biomeId === filter.biomeId);
			const baitContext = earningsStats.lastContext?.baitId === filter.baitId ? earningsStats.lastContext : breakdowns.find((breakdown) => breakdown.baitId === filter.baitId);
			return `${filter.biomeId === null ? "全部地图" : formatBiomeLabel(biomeContext ?? {
				biomeId: filter.biomeId,
				biomeName: `地图 ${filter.biomeId}`
			})} · ${filter.baitId === null ? "全部鱼饵" : baitContext?.baitName ?? filter.baitId}`;
		}
		function getEarningsCategoryDisplay(category) {
			const originalLabel = normalizeText(category) || "Unknown";
			return EARNINGS_CATEGORY_DISPLAY[originalLabel.toLowerCase()] ?? {
				label: originalLabel,
				tone: "unknown"
			};
		}
		function renderStatsList(container, entries, emptyText) {
			if (!container) return;
			container.replaceChildren();
			if (entries.length === 0) {
				const empty = document.createElement("span");
				empty.className = "empty-stat";
				empty.textContent = emptyText;
				container.appendChild(empty);
				return;
			}
			for (const [category, count] of entries) {
				const chip = document.createElement("span");
				const display = getEarningsCategoryDisplay(category);
				chip.className = "stat-chip";
				chip.dataset.tone = display.tone;
				chip.textContent = `${display.label} ×${formatStatNumber(count)}`;
				chip.title = chip.textContent;
				container.appendChild(chip);
			}
		}
		function renderEarningsStats() {
			if (!ui?.statsCasts) return;
			const { earningsStats } = getState();
			renderEarningsFilters(earningsStats);
			const filter = resolveEarningsFilter(earningsStats);
			const filteredStats = filter.ready ? filterEarningsStats(earningsStats, filter) : filterEarningsStats(earningsStats, {
				biomeId: "__missing__",
				baitId: "__missing__"
			});
			const netGold = filteredStats.gold + filteredStats.fishGold - filteredStats.baitCost;
			const averageNetGold = filteredStats.casts > 0 ? netGold / filteredStats.casts : 0;
			ui.statsScope.textContent = getEarningsScopeLabel(earningsStats, filter);
			ui.statsStart.textContent = filteredStats.startedAt ? `统计起点：${new Date(filteredStats.startedAt).toLocaleString()}` : "当前范围暂无数据";
			ui.statsCasts.textContent = formatStatNumber(filteredStats.casts);
			ui.statsFish.textContent = formatStatNumber(filteredStats.fish);
			ui.statsGold.textContent = formatStatNumber(filteredStats.gold, 2);
			ui.statsFishGold.textContent = formatStatNumber(filteredStats.fishGold, 2);
			ui.statsBaitCost.textContent = formatStatNumber(filteredStats.baitCost, 2);
			ui.statsNetGold.textContent = formatStatNumber(netGold, 2);
			ui.statsXp.textContent = formatStatNumber(filteredStats.xp, 2);
			ui.statsRelics.textContent = formatStatNumber(filteredStats.relics, 2);
			ui.statsTreasures.textContent = formatStatNumber(filteredStats.treasureChests);
			ui.statsGears.textContent = formatStatNumber(filteredStats.gears);
			ui.statsNetAverage.textContent = formatStatNumber(averageNetGold, 1);
			renderSignedStatTone(ui.statsNetGold, netGold);
			renderSignedStatTone(ui.statsNetAverage, averageNetGold);
			ui.statsCostNote.hidden = filteredStats.unknownBaitCostCasts === 0;
			ui.statsCostNote.textContent = filteredStats.unknownBaitCostCasts > 0 ? `${formatStatNumber(filteredStats.unknownBaitCostCasts)} 次抛竿未获取到鱼饵价格，成本和净收益暂未包含。` : "";
			const rarityEntries = Object.entries(filteredStats.rarityCounts).sort((left, right) => right[1] - left[1]);
			renderStatsList(ui.rarityStats, rarityEntries, "暂无收获");
		}
		function setPanelCollapsed(nextCollapsed) {
			panelCollapsed = Boolean(nextCollapsed);
			savePanelCollapsed(panelCollapsed);
			renderPanelCollapsed();
		}
		function renderPanelCollapsed() {
			if (!ui?.panel || !ui?.collapseToggle) return;
			const action = panelCollapsed ? "展开" : "收起";
			ui.panel.dataset.collapsed = panelCollapsed ? "true" : "false";
			ui.collapseToggle.textContent = panelCollapsed ? "＋" : "−";
			ui.collapseToggle.title = `${action}控制面板`;
			ui.collapseToggle.setAttribute("aria-label", `${action}控制面板`);
			ui.collapseToggle.setAttribute("aria-expanded", panelCollapsed ? "false" : "true");
		}
		function renderLoginMonitorSettings() {
			if (!ui?.loginMonitorToggle) return;
			const { loginMonitorSettings } = getState();
			ui.loginMonitorToggle.checked = loginMonitorSettings.enabled;
			ui.loginMonitorToggle.setAttribute("aria-checked", loginMonitorSettings.enabled ? "true" : "false");
			ui.loginMonitorMachineName.value = loginMonitorSettings.machineName;
			ui.loginMonitorBotKey.value = loginMonitorSettings.botKey;
			ui.loginMonitorUsername.value = loginMonitorSettings.username;
			ui.loginMonitorPassword.value = loginMonitorSettings.password;
			ui.loginMonitorRareDropNotifyToggle.checked = loginMonitorSettings.rareDropNotifyEnabled;
			ui.loginMonitorRareDropNotifyToggle.setAttribute("aria-checked", loginMonitorSettings.rareDropNotifyEnabled ? "true" : "false");
		}

		function renderAutoBiomeSettings() {
			if (!ui?.autoBiomeMaxBiome) return;
			const { autoBiomeCompetitionStatus, autoBiomeDailyQuestStatus, autoBiomeLastUpdatedAt, autoBiomeSettings, autoBiomeStatus } = getState();
			ui.autoBiomeMasteryXpBonusToggle.checked = autoBiomeSettings.includeMasteryXpBonus !== false;
			ui.autoBiomeMasteryXpBonusToggle.setAttribute("aria-checked", autoBiomeSettings.includeMasteryXpBonus !== false ? "true" : "false");
			ui.autoBiomeStatus.textContent = autoBiomeStatus;
			ui.autoBiomeCompetitionStatus.textContent = autoBiomeCompetitionStatus;
			ui.autoBiomeDailyQuestStatus.textContent = autoBiomeDailyQuestStatus;
			const priorityOrder = autoBiomeSettings.priorityOrder;
			const weightedExperienceIndex = priorityOrder.indexOf(AUTO_BIOME_PRIORITY_IDS.weightedExperience);
			if (!draggedAutoBiomePriorityId) {
				const itemsById = new Map(Array.from(ui.autoBiomePriorityItems, (item) => [item.getAttribute("data-priority-id"), item]));
				for (const priorityId of priorityOrder) {
					const item = itemsById.get(priorityId);
					if (item) ui.autoBiomePriorityList.appendChild(item);
				}
			}
			for (const item of ui.autoBiomePriorityList.children) {
				const priorityId = item.getAttribute("data-priority-id");
				const priorityIndex = priorityOrder.indexOf(priorityId);
				const state = item.querySelector(".priority-state");
				const moveButtons = item.querySelectorAll(".priority-move");
				if (priorityId === AUTO_BIOME_PRIORITY_IDS.weightedExperience) {
					item.setAttribute("data-enabled", "boundary");
					state.textContent = "分界线";
				} else if (priorityIndex < weightedExperienceIndex) {
					item.setAttribute("data-enabled", "true");
					state.textContent = "已启用";
				} else {
					item.setAttribute("data-enabled", "false");
					state.textContent = "未启用";
				}
				moveButtons[0].disabled = priorityIndex === 0;
				moveButtons[1].disabled = priorityIndex === priorityOrder.length - 1;
			}
			const unlockedBiomes = getState().unlockedBiomes ?? [];
			const maxUnlockedBiome = unlockedBiomes.reduce((max, id) => Math.max(max, Number(id) || 0), 0);
			const maxBiomeOptions = [{ value: "0", label: "不限" }];
			for (let n = 1; n <= maxUnlockedBiome; n++) maxBiomeOptions.push({ value: String(n), label: `B${n}` });
			ui.autoBiomeMaxBiome.replaceChildren();
			for (const option of maxBiomeOptions) {
				const element = document.createElement("option");
				element.value = option.value;
				element.textContent = option.label;
				ui.autoBiomeMaxBiome.appendChild(element);
			}
			const requestedMaxBiome = Number(autoBiomeSettings.maxBiome) || 0;
			ui.autoBiomeMaxBiome.value = requestedMaxBiome > 0 && requestedMaxBiome <= maxUnlockedBiome ? String(requestedMaxBiome) : "0";
			for (const input of ui.autoBiomeWeightInputs) input.checked = Number(input.value) === autoBiomeSettings.biomeWeight;
			ui.autoBiomeUpdatedAt.textContent = autoBiomeLastUpdatedAt ? new Date(autoBiomeLastUpdatedAt).toLocaleTimeString() : "等待接口数据";
		}
		function renderAutoBaitSettings() {
			if (!ui?.autoBaitGrade) return;
			const { autoBaitLastPurchasedAt, autoBaitSettings, autoBaitStatus, gameAutoFishingSettings, scheduleSettings } = getState();
			const usesPaidGameAutoFishingBait = !["auto", "default"].includes(gameAutoFishingSettings.baitGrade) && (gameAutoFishingSettings.enabled || scheduleSettings.gameAutoFishingDuringRest);
			ui.autoBaitStatus.textContent = autoBaitStatus;
			ui.autoBaitGrade.value = autoBaitSettings.baitGrade;
			ui.autoBaitPurchaseSettings.hidden = autoBaitSettings.baitGrade === 'default' && !usesPaidGameAutoFishingBait;
			if (!autoBaitPurchaseSettingsDirty) {
				ui.autoBaitMinimumQuantity.value = String(autoBaitSettings.minimumQuantity);
				ui.autoBaitPurchaseQuantity.value = String(autoBaitSettings.purchaseQuantity);
			}
			ui.autoBaitLastPurchasedAt.textContent = autoBaitLastPurchasedAt ? new Date(autoBaitLastPurchasedAt).toLocaleTimeString() : "暂无";
		}
		function renderAutoBossSettings() {
			if (!ui?.autoBossStatus) return;
			const { autoBossSettings, autoBossStatus } = getState();
			ui.autoBossStatus.textContent = autoBossStatus;
		}
		function renderGameAutoFishingSettings() {
			if (!ui?.gameAutoFishingToggle) return;
			const { gameAutoFishingSettings, gameAutoFishingStatus } = getState();
			ui.gameAutoFishingToggle.checked = gameAutoFishingSettings.enabled;
			ui.gameAutoFishingToggle.setAttribute("aria-checked", gameAutoFishingSettings.enabled ? "true" : "false");
			ui.gameAutoFishingStatus.textContent = gameAutoFishingStatus;
		}
		function renderClickDelaySettings() {
			if (!ui?.shortDelayMinSeconds) return;
			const { clickDelaySettings } = getState();
			ui.shortDelayMinSeconds.value = String(clickDelaySettings.shortDelayMinSeconds);
			ui.shortDelayMaxSeconds.value = String(clickDelaySettings.shortDelayMaxSeconds);
			ui.longDelayMinSeconds.value = String(clickDelaySettings.longDelayMinSeconds);
			ui.longDelayMaxSeconds.value = String(clickDelaySettings.longDelayMaxSeconds);
			ui.longDelayChancePercent.value = String(clickDelaySettings.longDelayChancePercent);
		}
		function renderToggle() {
			if (!ui?.toggle) return;
			const { enabled } = getState();
			ui.toggle.textContent = enabled ? "停止" : "启动";
			ui.toggle.dataset.enabled = enabled ? "true" : "false";
		}
		function renderCaptchaBypassToggle() {
			if (!ui?.captchaBypassToggle) return;
			const { captchaBypassEnabled } = getState();
			ui.captchaBypassToggle.checked = captchaBypassEnabled;
			ui.captchaBypassToggle.setAttribute("aria-checked", captchaBypassEnabled ? "true" : "false");
		}
		function renderVerificationHistory() {
			if (!ui?.verificationHistory) return;
			const { verificationHistory = [] } = getState();
			ui.verificationHistory.replaceChildren();
			if (verificationHistory.length === 0) {
				const empty = document.createElement("div");
				empty.className = "verification-history-empty";
				empty.textContent = "暂无验证记录";
				ui.verificationHistory.appendChild(empty);
				return;
			}
			const formatter = new Intl.DateTimeFormat("zh-CN", {
				day: "2-digit",
				hour: "2-digit",
				hour12: false,
				minute: "2-digit",
				month: "2-digit",
				second: "2-digit",
				year: "numeric"
			});
			for (const entry of verificationHistory) {
				const item = document.createElement("div");
				const time = document.createElement("time");
				const status = document.createElement("span");
				const date = new Date(entry.timestamp);
				item.className = "verification-history-item";
				time.className = "verification-history-time";
				time.dateTime = date.toISOString();
				time.textContent = formatter.format(date);
				status.className = "verification-history-status";
				status.dataset.success = entry.success ? "true" : "false";
				status.textContent = entry.success ? "成功" : "失败";
				item.append(time, status);
				ui.verificationHistory.appendChild(item);
			}
		}
		createPanel();
		return {
			renderAutoBaitSettings,
			renderAutoBiomeSettings,
			renderAutoBossSettings,
			renderCaptchaBypassToggle,
			renderClickDelaySettings,
			renderEarningsStats,
			renderGameAutoFishingSettings,
			renderToggle,
			renderVerificationHistory,
			renderLoginMonitorSettings,
			setNextDelay,
			setStatus,
			setAutoSellStatus,
			updateClickCount
		};
	}
	var enabled = loadEnabled();
	var captchaBypassEnabled = loadCaptchaBypassEnabled();
	var verificationHistory = loadVerificationHistory();
	var clickDelaySettings = loadClickDelaySettings();
	var gameAutoFishingSettings = loadGameAutoFishingSettings();
	var scheduleSettings = loadScheduleSettings();
	var autoBiomeSettings = loadAutoBiomeSettings();
	var autoBaitSettings = loadAutoBaitSettings();
	var autoBossSettings = loadAutoBossSettings();
	var earningsStats = loadEarningsStats();
	var loopId = 0;
	var clickCount = 0;
	var captcha = null;
	var panel = null;
	var schedule = null;
	var gameAutoFishing = null;
	var autoBiome = null;
	var autoBait = null;
	var autoBoss = null;
	var forceNextAutoBaitCheck = false;
	var pendingCaptchaChallenge = null;
	var pendingStaffQuestion = null;
	var pendingCompetitionResponses = new Map();
	var pendingGuildBoosterResponse = null;
	var pendingQuestResponse = null;
	var pendingWeatherResponses = new Map();
	var gameState = createGameStateStore();
	var fishingActivityWatchdog = createFishingActivityWatchdog();
	var CLICK_DELAY_SETTING_FIELDS = new Set([
		"longDelayChancePercent",
		"longDelayMaxSeconds",
		"longDelayMinSeconds",
		"shortDelayMaxSeconds",
		"shortDelayMinSeconds"
	]);
	function handleWeatherResponse(response) {
		if (autoBiome) autoBiome.handleWeatherResponse(response);
		else pendingWeatherResponses.set(`${response.source ?? "fetch"}:${response.pathname}`, response);
	}
	function notifyNoteworthyCatch(result) {
		const botKey = loginMonitorSettings.botKey;
		if (!botKey || !loginMonitorSettings.rareDropNotifyEnabled) return;
		const fishRarity = String(result.rarity ?? "").trim().toLowerCase();
		const gearRarity = String(result.gear?.rarity ?? "").trim().toLowerCase();
		const isNoteworthyFish = Boolean(result.fish?.name) && (fishRarity === "exotic" || fishRarity === "arcane");
		const isNoteworthyGear = Boolean(result.gear) && (gearRarity === "exotic" || gearRarity === "arcane");
		if (!isNoteworthyFish && !isNoteworthyGear) return;
		const rarity = isNoteworthyFish ? (fishRarity === "exotic" ? "奇异" : "奥术") : (gearRarity === "exotic" ? "奇异" : "奥术");
		const name = isNoteworthyFish ? exportFishGetChineseName(String(result.fish?.name ?? "").trim()) : String(result.gear?.name ?? "").trim();
		const verb = isNoteworthyFish ? "钓到" : "获得";
		const kind = isNoteworthyFish ? "鱼" : "装备";
		let detail = "";
		if (isNoteworthyFish) {
			const biomeId = String(result.currentBiome ?? "").trim();
			if (biomeId) detail = `（B${biomeId}）`;
		} else {
			const slot = String(result.gear?.slot ?? "").trim();
			const slotLabel = GEAR_SLOT_DISPLAY[slot] ?? slot;
			if (slotLabel) detail = `（${slotLabel}）`;
		}
		const message = formatBotMessage(`🎣 ${verb}${rarity}${kind}：${name || "未知"}${detail}`);
		sendWxBot(botKey, message);
		console.log(`[稀有通知] ${message}`);
	}

	function recordCastResult(result, { pathname } = {}) {
		fishingActivityWatchdog.markFishing();
		notifyNoteworthyCatch(result);
		earningsStats = updateEarningsStats(earningsStats, result, getCastEarningsContext(result));
		saveEarningsStats(earningsStats);
		panel?.renderEarningsStats();
		autoBiome?.handleCastResult(result);
		autoBait?.handleCastResult(result, pathname === "/api/game/auto-cast" && gameAutoFishingSettings.baitGrade !== "auto" ? {
			baitGrade: gameAutoFishingSettings.baitGrade,
			contextLabel: "内置自动钓鱼"
		} : void 0);
	}
	installEventSourceInterceptor({ onWeatherUpdate(payload) {
		handleWeatherResponse({
			pathname: "/api/game/weather/stream",
			payload,
			source: "stream"
		});
	} });
	installFetchInterceptor({
		onCastResult: recordCastResult,
		onCaptchaChallenge(challenge) {
			if (captcha) captcha.handleChallenge(challenge);
			else pendingCaptchaChallenge = challenge;
		},
		onCaptchaVerified() {
			pendingCaptchaChallenge = null;
			captcha?.clearChallenge();
		},
		onCompetitionResponse(response) {
			if (autoBiome) {
				if (autoBiome.handleCompetitionResponse(response)) autoBait?.handleStateChanged({ force: true });
			} else pendingCompetitionResponses.set(response.pathname, response);
		},
		onGameStateResponse(response) {
			if (gameState.handleResponse(response).shouldEvaluate && autoBiome) handleAutomationStateChanged();
		},
		onGuildBoosterResponse(response) {
			if (autoBiome) autoBiome.handleGuildBoosterResponse(response);
			else pendingGuildBoosterResponse = response;
		},
		onQuestResponse(response) {
			if (autoBiome) autoBiome.handleQuestResponse(response);
			else pendingQuestResponse = response;
		},
		onStaffQuestion(question) {
			if (captcha) captcha.handleStaffQuestion(question);
			else pendingStaffQuestion = question;
		},
		onStaffQuestionResolved() {
			pendingStaffQuestion = null;
			captcha?.clearStaffQuestion();
		},
		onWeatherResponse(response) {
			handleWeatherResponse(response);
		}
	});
	function setLoginMonitorEnabled(nextEnabled) {
		loginMonitorSettings = { ...loginMonitorSettings, enabled: Boolean(nextEnabled) };
		saveLoginMonitorSettings(loginMonitorSettings);
		if (loginMonitorSettings.enabled) startLoginMonitor();
		else stopLoginMonitor();
		panel?.renderLoginMonitorSettings();
	}
	function setLoginMonitorConfig(patch) {
		const next = { ...loginMonitorSettings };
		if ("machineName" in patch) next.machineName = String(patch.machineName ?? "").trim();
		if ("botKey" in patch) next.botKey = String(patch.botKey ?? "").trim();
		if ("username" in patch) next.username = String(patch.username ?? "").trim();
		if ("password" in patch) next.password = String(patch.password ?? "");
		if ("rareDropNotifyEnabled" in patch) next.rareDropNotifyEnabled = Boolean(patch.rareDropNotifyEnabled);
		loginMonitorSettings = next;
		saveLoginMonitorSettings(loginMonitorSettings);
		panel?.renderLoginMonitorSettings();
	}

	function recordVerificationResult(entry) {
		verificationHistory = addVerificationHistoryEntry(verificationHistory, entry);
		saveVerificationHistory(verificationHistory);
		panel?.renderVerificationHistory();
	}
	function resetEarningsStats() {
		if (!window.confirm("确定重置全部收益统计吗？此操作无法撤销。")) return;
		earningsStats = createEmptyEarningsStats();
		saveEarningsStats(earningsStats);
		panel.renderEarningsStats();
	}
	function getPanelState() {
		return {
			captchaBypassEnabled,
			verificationHistory,
			clickDelaySettings,
			clickCount,
			earningsStats,
			enabled,
			gameAutoFishingSettings,
			autoBaitSettings,
			autoBiomeSettings,
			autoBossSettings,
			loginMonitorSettings,
			unlockedBiomes: gameState.getPlayerSnapshot()?.unlockedBiomes ?? [],
			...autoBiome?.getSnapshot() ?? {
				autoBiomeCompetitionBiomes: {
					guildTournamentBiomeId: null,
					personalDerbyBiomeId: null
				},
				autoBiomeCompetitionStatus: "自动换图开启后检测",
				autoBiomeCompetitionUpdatedAt: 0,
				autoBiomeDailyQuestStatus: "自动换图开启后读取",
				autoBiomeDailyQuestUpdatedAt: 0,
				autoBiomeDailyQuests: [],
				autoBiomeLastUpdatedAt: 0,
				autoBiomeStatus: "等待天气数据",
				autoBiomeTarget: null,
				autoBiomeWeatherByBiome: {}
			},
			...autoBait?.getSnapshot() ?? {
				autoBaitCurrentBaitId: null,
				autoBaitCurrentQuantity: null,
				autoBaitLastCheckedAt: 0,
				autoBaitLastPurchasedAt: 0,
				autoBaitStatus: "未启用"
			},
			...autoBoss?.getSnapshot() ?? {
				autoBossChecking: false,
				autoBossLastAttackAt: 0,
				autoBossLastDamage: 0,
				autoBossLastStat: null,
				autoBossStatus: "未启用"
			},
			...gameAutoFishing?.getSnapshot() ?? {
				gameAutoFishingMayBeActive: false,
				gameAutoFishingStatus: "未启用"
			},
		};
	}
	function handleAutomationStateChanged({ forceBait = false } = {}) {
		forceNextAutoBaitCheck ||= forceBait;
		const biomeUpdate = autoBiome?.handleStateChanged();
		if (!enabled || !autoBiomeSettings.enabled) Promise.resolve(biomeUpdate).then(() => {
			const force = forceNextAutoBaitCheck;
			forceNextAutoBaitCheck = false;
			return autoBait?.handleStateChanged({ force });
		});
	}
	function reloadIfFishingIdle() {
		if (!enabled || gameAutoFishingSettings.enabled || schedule?.getSnapshot().schedulePhase === "rest") return false;
		const timeoutMilliseconds = 1 * 6e4;
		if (!fishingActivityWatchdog.observe(timeoutMilliseconds)) return false;
		panel.setStatus("连续 1 分钟未钓鱼，正在刷新页面");
		panel.setNextDelay("—");
		console.warn("[自动抛竿] 连续 1 分钟未收到抛竿结果，正在刷新页面。");
		window.location.reload();
		return true;
	}
	function findCastButton() {
		const buttons = document.querySelectorAll("button");
		for (const button of buttons) {
			if (!normalizeText(button.textContent).includes(CONFIG.buttonText)) continue;
			if (button.disabled) continue;
			if (button.getAttribute("aria-disabled") === "true") continue;
			if (!isDisplayed(button)) continue;
			return button;
		}
		return null;
	}
	function findCooldownButton() {
		const buttons = document.querySelectorAll("button");
		for (const button of buttons) {
			if (!isCooldownButton(button, CONFIG.cooldownButtonText)) continue;
			if (!isVisible(button)) continue;
			return button;
		}
		return null;
	}
	function dispatchPointerEvent(target, type, options) {
		if (typeof unsafeWindow.PointerEvent !== "function") return;
		target.dispatchEvent(new unsafeWindow.PointerEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			pointerId: 1,
			pointerType: "mouse",
			isPrimary: true,
			width: 1,
			height: 1,
			pressure: options.buttons === 1 ? .5 : 0,
			button: 0,
			...options
		}));
	}
	function dispatchMouseEvent(target, type, options) {
		target.dispatchEvent(new unsafeWindow.MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			composed: true,
			view: unsafeWindow,
			button: 0,
			...options
		}));
	}
	async function simulateClick(button, currentLoopId) {
		if (!button?.isConnected) return false;
		button.scrollIntoView({
			block: "center",
			inline: "center",
			behavior: "auto"
		});
		await sleep(60);
		if (!enabled || currentLoopId !== loopId || !button.isConnected || schedule.isWorkExpired()) return false;
		if (captcha.stopIfVerificationFound()) return false;
		const rect = button.getBoundingClientRect();
		const clientX = rect.left + rect.width * (.42 + Math.random() * .16);
		const clientY = rect.top + rect.height * (.38 + Math.random() * .24);
		const hitElement = document.elementFromPoint(clientX, clientY);
		if (!hitElement || hitElement !== button && !button.contains(hitElement)) {
			console.warn("[自动抛竿] 按钮可能被其他元素遮挡：", hitElement);
			return false;
		}
		const eventTarget = hitElement;
		try {
			button.focus({ preventScroll: true });
		} catch {
			button.focus();
		}
		const baseOptions = {
			clientX,
			clientY,
			screenX: unsafeWindow.screenX + clientX,
			screenY: unsafeWindow.screenY + clientY
		};
		dispatchPointerEvent(eventTarget, "pointerover", {
			...baseOptions,
			buttons: 0
		});
		dispatchMouseEvent(eventTarget, "mouseover", {
			...baseOptions,
			buttons: 0,
			detail: 0
		});
		dispatchPointerEvent(eventTarget, "pointermove", {
			...baseOptions,
			buttons: 0
		});
		dispatchMouseEvent(eventTarget, "mousemove", {
			...baseOptions,
			buttons: 0,
			detail: 0
		});
		dispatchPointerEvent(eventTarget, "pointerdown", {
			...baseOptions,
			buttons: 1
		});
		dispatchMouseEvent(eventTarget, "mousedown", {
			...baseOptions,
			buttons: 1,
			detail: 1
		});
		await sleep(randomInt(CONFIG.mouseDownMin, CONFIG.mouseDownMax));
		const wasCancelled = !enabled || currentLoopId !== loopId;
		dispatchPointerEvent(eventTarget, "pointerup", {
			...baseOptions,
			buttons: 0
		});
		dispatchMouseEvent(eventTarget, "mouseup", {
			...baseOptions,
			buttons: 0,
			detail: 1
		});
		if (wasCancelled) return false;
		dispatchMouseEvent(eventTarget, "click", {
			...baseOptions,
			buttons: 0,
			detail: 1
		});
		return true;
	}
	async function waitForButton(currentLoopId) {
		const cooldownWatchdog = createCooldownWatchdog(CONFIG.cooldownReloadDelay);
		while (enabled && currentLoopId === loopId) {
			if (captcha.stopIfVerificationFound()) return null;
			if (schedule.isWorkExpired()) return null;
			if (reloadIfFishingIdle()) return null;
			const button = findCastButton();
			if (button) return button;
			const cooldownButton = findCooldownButton();
			if (cooldownWatchdog.observe(Boolean(cooldownButton))) {
				panel.setStatus("冷却倒计时卡住，正在刷新页面");
				panel.setNextDelay("—");
				console.warn("[自动抛竿] 冷却倒计时持续超过 10 秒，正在刷新页面。", cooldownButton);
				window.location.reload();
				return null;
			}
			panel.setStatus("等待“抛竿线”按钮出现");
			panel.setNextDelay("—");
			await sleep(CONFIG.buttonPollInterval);
		}
		return null;
	}
	async function waitWithCountdown(milliseconds, isLongDelay, currentLoopId) {
		const endTime = Date.now() + milliseconds;
		while (enabled && currentLoopId === loopId) {
			if (captcha.stopIfVerificationFound()) return false;
			if (schedule.isWorkExpired()) return false;
			if (reloadIfFishingIdle()) return false;
			const remaining = endTime - Date.now();
			if (remaining <= 0) {
				panel.setNextDelay("准备点击");
				return true;
			}
			const seconds = (remaining / 1e3).toFixed(1);
			panel.setStatus(isLongDelay ? "随机长等待中" : "等待下一次操作");
			panel.setNextDelay(isLongDelay ? `${seconds} 秒（长等待）` : `${seconds} 秒`);
			await sleep(Math.min(100, remaining));
		}
		return false;
	}
	async function waitForGameAutoFishingStopped(currentLoopId) {
		while (currentLoopId === loopId) {
			if (gameAutoFishing.ensureStopped()) return true;
			panel.setStatus("正在停止游戏内置自动钓鱼");
			panel.setNextDelay("停止后恢复脚本自动钓鱼");
			await sleep(CONFIG.gameAutoFishingPollInterval);
		}
		return false;
	}
	async function waitForGameAutoFishingWork(currentLoopId) {
		while (enabled && currentLoopId === loopId && gameAutoFishingSettings.enabled) {
			if (schedule.isWorkExpired()) return;
			if (captcha.stopIfVerificationFound()) return;
			const state = await gameAutoFishing.ensureActive();
			panel.setStatus(state.active ? "游戏内置自动钓鱼运行中" : state.available ? "等待游戏内置自动钓鱼可用" : "等待进入钓鱼页面");
			panel.setNextDelay(state.active ? "本轮结束后自动续期" : "自动重试启动");
			await sleep(CONFIG.gameAutoFishingPollInterval);
		}
	}
	async function runLoop(currentLoopId) {
		while (enabled && currentLoopId === loopId) {
			if (!await schedule.waitForWork(currentLoopId)) return;
			if (gameAutoFishingSettings.enabled) {
				await waitForGameAutoFishingWork(currentLoopId);
				if (!enabled || currentLoopId !== loopId) return;
				if (schedule.shouldEnterRest(currentLoopId)) continue;
			}
			if (!await waitForGameAutoFishingStopped(currentLoopId) || !enabled) return;
			if (!await waitForButton(currentLoopId)) {
				if (schedule.shouldEnterRest(currentLoopId)) continue;
				return;
			}
			const delay = getRandomClickDelay(clickDelaySettings);
			if (!await waitWithCountdown(delay.milliseconds, delay.isLongDelay, currentLoopId)) {
				if (schedule.shouldEnterRest(currentLoopId)) continue;
				return;
			}
			const latestButton = findCastButton();
			if (!latestButton) continue;
			if (schedule.isWorkExpired()) continue;
			if (autoBiome?.isSwitching() || autoBait?.isChecking()) {
				await sleep(CONFIG.buttonPollInterval);
				continue;
			}
			panel.setStatus("正在模拟点击");
			panel.setNextDelay("—");
			const clicked = await simulateClick(latestButton, currentLoopId);
			if (!enabled || currentLoopId !== loopId) return;
			if (clicked) {
				clickCount += 1;
				panel.updateClickCount();
				const time = new Date().toLocaleTimeString();
				panel.setStatus(`已点击，时间：${time}`);
				console.info(`[自动抛竿] 第 ${clickCount} 次点击`, latestButton);
				await sleep(150);
			} else {
				if (captcha.isBypassInProgress() || captcha.stopIfVerificationFound()) return;
				if (schedule.isWorkExpired()) continue;
				panel.setStatus("本次未点击，重新等待");
				await sleep(500);
			}
		}
	}
	function startRunLoop() {
		const currentLoopId = loopId;
		runLoop(currentLoopId).catch((error) => {
			console.error("[自动抛竿] 运行异常：", error);
			if (currentLoopId === loopId) panel.setStatus(`运行异常：${error.message}`);
		});
	}
	function setEnabled(nextEnabled, { preserveSchedule = false } = {}) {
		enabled = Boolean(nextEnabled);
		saveEnabled(enabled);
		if (!preserveSchedule) schedule.reset();
		fishingActivityWatchdog.markFishing();
		if (!enabled) captcha.cancel();
		loopId += 1;
		panel.renderToggle();
		if (enabled) {
			panel.setStatus(gameAutoFishingSettings.enabled ? "已启动，正在接管游戏内置自动钓鱼" : "已启动，正在查找按钮");
			panel.setNextDelay("—");
			startRunLoop();
		} else {
			const currentLoopId = loopId;
			panel.setNextDelay("—");
			if (gameAutoFishing.ensureStopped()) panel.setStatus("已停止");
			else {
				panel.setStatus("已停止，正在确认内置自动钓鱼已关闭");
				waitForGameAutoFishingStopped(currentLoopId).then((stopped) => {
					if (stopped && currentLoopId === loopId && !enabled) panel.setStatus("已停止");
				});
			}
		}
		handleAutomationStateChanged();
		autoBoss?.handleStateChanged();
	}
	function setGameAutoFishingEnabled(nextEnabled) {
		gameAutoFishingSettings = {
			...gameAutoFishingSettings,
			enabled: Boolean(nextEnabled)
		};
		saveGameAutoFishingSettings(gameAutoFishingSettings);
		panel.renderGameAutoFishingSettings();
		panel.renderAutoBaitSettings();
		if (enabled) {
			loopId += 1;
			fishingActivityWatchdog.markFishing();
			startRunLoop();
		}
	}
	function setCaptchaBypassEnabled(nextEnabled) {
		captchaBypassEnabled = Boolean(nextEnabled);
		saveCaptchaBypassEnabled(captchaBypassEnabled);
		panel.renderCaptchaBypassToggle();
		captcha.handleBypassSettingChanged();
	}
	function setAutoBiomeWeight(nextWeight) {
		autoBiomeSettings = {
			...autoBiomeSettings,
			biomeWeight: normalizeAutoBiomeWeight(nextWeight, autoBiomeSettings.biomeWeight)
		};
		saveAutoBiomeSettings(autoBiomeSettings);
		panel.renderAutoBiomeSettings();
		handleAutomationStateChanged();
	}
	function setAutoBiomeMasteryXpBonusEnabled(nextEnabled) {
		autoBiomeSettings = {
			...autoBiomeSettings,
			includeMasteryXpBonus: Boolean(nextEnabled)
		};
		saveAutoBiomeSettings(autoBiomeSettings);
		panel.renderAutoBiomeSettings();
		handleAutomationStateChanged();
	}
	function setAutoBiomeMaxBiome(nextValue) {
		autoBiomeSettings = {
			...autoBiomeSettings,
			maxBiome: normalizeAutoBiomeMaxBiome(nextValue, autoBiomeSettings.maxBiome)
		};
		saveAutoBiomeSettings(autoBiomeSettings);
		panel.renderAutoBiomeSettings();
		handleAutomationStateChanged();
	}

	function setAutoBiomePriorityOrder(nextPriorityOrder) {
		autoBiomeSettings = {
			...autoBiomeSettings,
			priorityOrder: normalizeAutoBiomePriorityOrder(nextPriorityOrder)
		};
		saveAutoBiomeSettings(autoBiomeSettings);
		panel.renderAutoBiomeSettings();
		handleAutomationStateChanged({ forceBait: true });
	}
	function updateAutoBaitSettings(nextSettings) {
		autoBaitSettings = {
			...autoBaitSettings,
			...nextSettings
		};
		saveAutoBaitSettings(autoBaitSettings);
		panel.renderAutoBaitSettings();
		handleAutomationStateChanged({ forceBait: true });
	}
	function setAutoBaitGrade(nextGrade) {
		updateAutoBaitSettings({ baitGrade: normalizeAutoBaitGrade(nextGrade, autoBaitSettings.baitGrade) });
	}
	function setAutoBaitPurchaseSettings({ minimumQuantity, purchaseQuantity }) {
		updateAutoBaitSettings({
			minimumQuantity: normalizeAutoBaitMinimumQuantity(minimumQuantity, autoBaitSettings.minimumQuantity),
			purchaseQuantity: normalizeAutoBaitPurchaseQuantity(purchaseQuantity, autoBaitSettings.purchaseQuantity)
		});
	}
	function setClickDelaySetting(field, value) {
		if (!CLICK_DELAY_SETTING_FIELDS.has(field)) return;
		clickDelaySettings = normalizeClickDelaySettings({
			...clickDelaySettings,
			[field]: value
		}, clickDelaySettings);
		saveClickDelaySettings(clickDelaySettings);
		panel.renderClickDelaySettings();
	}
	var exportFishBiomeMap = {};

	var EXPORT_FISH_RARITY_ORDER = { 'Exotic': 8, 'Arcane': 9 };
	var EXPORT_FISH_RARITY_ZH = { 'Exotic': '奇异', 'Arcane': '奥术' };
	var EXPORT_FISH_TARGET_RARITIES = ['Exotic', 'Arcane'];

	function exportFishBuildBiomeMap() {
		const map = {};
		if (!unsafeWindow.BIOMES) return map;
		for (const [id, biome] of Object.entries(unsafeWindow.BIOMES)) {
			if (biome.fish) {
				for (const rarity in biome.fish) {
					biome.fish[rarity].forEach(fish => {
						map[fish.name] = { biomeId: parseInt(id), biomeName: biome.name };
					});
				}
			}
		}
		return map;
	}

	function exportFishGetChineseName(englishName) {
		if (unsafeWindow.cnItems && unsafeWindow.cnItems[englishName]) {
			const trans = unsafeWindow.cnItems[englishName];
			return Array.isArray(trans) ? trans[0] : trans;
		}
		return englishName;
	}

	function exportFishParseInventory(data) {
		const inventory = [];
		const fishList = data.inventory || data.fish || (Array.isArray(data) ? data : []);
		fishList.forEach(item => {
			const name = item.name || item.fishName;
			if (!name) return;
			const rarity = item.rarity || 'Common';
			if (!EXPORT_FISH_TARGET_RARITIES.includes(rarity)) return;
			const biomeInfo = exportFishBiomeMap[name] || { biomeId: 0 };
			inventory.push({
				name_zh: exportFishGetChineseName(name),
				quantity: item.quantity || item.count || 1,
				rarity: rarity,
				biomeId: biomeInfo.biomeId,
				biomeCode: biomeInfo.biomeId > 0 ? `B${biomeInfo.biomeId}` : '?'
			});
		});
		inventory.sort((a, b) => (a.biomeId - b.biomeId) || (EXPORT_FISH_RARITY_ORDER[a.rarity] - EXPORT_FISH_RARITY_ORDER[b.rarity]));
		return inventory;
	}

	function exportFishParseMastery(allBiomesData) {
		const masteryInfo = [];
		const seen = new Set();
		allBiomesData.forEach(biomeData => {
			(biomeData.targetFish || []).forEach(fish => {
				const name = fish.name || fish.fishName;
				if (!name) return;
				const rarity = fish.rarity || 'Unknown';
				if (!EXPORT_FISH_TARGET_RARITIES.includes(rarity)) return;
				const key = `${name}_${biomeData.biomeId}`;
				if (seen.has(key)) return;
				seen.add(key);
				const sacrificed = biomeData.progress[name] || 0;
				const required = fish.required || fish.count || fish.needed || fish.total || 1;
				const remaining = Math.max(0, required - sacrificed);
				masteryInfo.push({
					name_zh: exportFishGetChineseName(name),
					rarity: rarity,
					biomeId: biomeData.biomeId,
					biomeCode: `B${biomeData.biomeId}`,
					sacrificed: sacrificed,
					remaining: remaining,
					required: required
				});
			});
		});
		masteryInfo.sort((a, b) => (a.biomeId - b.biomeId) || (EXPORT_FISH_RARITY_ORDER[a.rarity] - EXPORT_FISH_RARITY_ORDER[b.rarity]));
		return masteryInfo;
	}

	function exportFishPrepareTableData(inventory, mastery) {
		const invByBiome = {};
		const mastByBiome = {};

		inventory.forEach(fish => {
			const biome = fish.biomeCode;
			const rarity = fish.rarity;
			if (!invByBiome[biome]) invByBiome[biome] = {};
			if (!invByBiome[biome][rarity]) invByBiome[biome][rarity] = [];
			invByBiome[biome][rarity].push({ name: fish.name_zh, qty: fish.quantity });
		});

		mastery.forEach(fish => {
			if (fish.remaining <= 0) return;
			const biome = fish.biomeCode;
			const rarity = fish.rarity;
			if (!mastByBiome[biome]) mastByBiome[biome] = {};
			if (!mastByBiome[biome][rarity]) mastByBiome[biome][rarity] = [];
			mastByBiome[biome][rarity].push({ name: fish.name_zh, qty: fish.remaining });
		});

		const allBiomes = [...new Set([...Object.keys(invByBiome), ...Object.keys(mastByBiome)])];
		allBiomes.sort((a, b) => {
			const numA = parseInt((a || '').replace('B', '')) || 0;
			const numB = parseInt((b || '').replace('B', '')) || 0;
			return numA - numB;
		});

		return { invByBiome, mastByBiome, allBiomes };
	}

	function exportFishGenerateImage(tableData, username, userId) {
		const { invByBiome, mastByBiome, allBiomes } = tableData;

		// 计算每个区域的行数
		const biomeRows = allBiomes.map(biome => {
			const exoticInv = invByBiome[biome]?.['Exotic'] || [];
			const exoticMast = mastByBiome[biome]?.['Exotic'] || [];
			const arcaneInv = invByBiome[biome]?.['Arcane'] || [];
			const arcaneMast = mastByBiome[biome]?.['Arcane'] || [];
			return Math.max(exoticInv.length, exoticMast.length, arcaneInv.length, arcaneMast.length, 1);
		});

		// 配置
		const config = {
			cellPadding: 8,
			cellHeight: 28,
			headerHeight: 70,
			colWidths: [60, 180, 180, 180, 180], // 区域、奇异-持有、奇异-需要、奥术-持有、奥术-需要
			fontSize: 13,
			headerFontSize: 15,
			titleFontSize: 18,
			colors: {
				bg: '#ffffff',
				headerBg: '#4a5568',
				headerText: '#ffffff',
				subHeaderBg: '#e2e8f0',
				subHeaderText: '#2d3748',
				regionBg: '#f7fafc',
				text: '#1a202c',
				border: '#cbd5e0',
				regionBorder: '#2d3748',
				titleBg: '#2d3748',
				titleText: '#ffffff'
			}
		};

		const totalWidth = config.colWidths.reduce((a, b) => a + b, 0);
		const totalDataHeight = biomeRows.reduce((a, b) => a + b * config.cellHeight, 0);
		const titleHeight = 40;
		const totalHeight = titleHeight + config.headerHeight + totalDataHeight + 20;

		// 创建 canvas
		const canvas = document.createElement('canvas');
		const dpr = 2; // 高清
		canvas.width = totalWidth * dpr;
		canvas.height = totalHeight * dpr;
		const ctx = canvas.getContext('2d');
		ctx.scale(dpr, dpr);

		// 背景
		ctx.fillStyle = config.colors.bg;
		ctx.fillRect(0, 0, totalWidth, totalHeight);

		// 标题栏
		ctx.fillStyle = config.colors.titleBg;
		ctx.fillRect(0, 0, totalWidth, titleHeight);
		ctx.fillStyle = config.colors.titleText;
		ctx.font = `bold ${config.titleFontSize}px "Microsoft YaHei", sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(`🎣 Arcane Angler 换鱼表格 - ${username} (${userId})`, totalWidth / 2, titleHeight / 2);

		let y = titleHeight;

		// 第一行表头：区域 | 奇异 | 奥术
		const h1 = config.headerHeight / 2;
		ctx.fillStyle = config.colors.headerBg;
		ctx.fillRect(0, y, totalWidth, h1);

		ctx.fillStyle = config.colors.headerText;
		ctx.font = `bold ${config.headerFontSize}px "Microsoft YaHei", sans-serif`;
		ctx.textAlign = 'center';

		// 区域
		ctx.fillText('区域', config.colWidths[0] / 2, y + h1 / 2);
		// 奇异（合并两列）
		ctx.fillText('奇异', config.colWidths[0] + config.colWidths[1] + config.colWidths[2] / 2, y + h1 / 2);
		// 奥术（合并两列）
		ctx.fillText('奥术', config.colWidths[0] + config.colWidths[1] + config.colWidths[2] + config.colWidths[3] + config.colWidths[4] / 2, y + h1 / 2);

		y += h1;

		// 第二行表头：持有 | 需要 | 持有 | 需要
		ctx.fillStyle = config.colors.subHeaderBg;
		ctx.fillRect(0, y, totalWidth, h1);

		ctx.fillStyle = config.colors.subHeaderText;
		ctx.font = `bold ${config.fontSize}px "Microsoft YaHei", sans-serif`;

		let x = config.colWidths[0];
		for (let c = 1; c <= 4; c++) {
			ctx.fillText(c % 2 === 1 ? '持有' : '需要', x + config.colWidths[c] / 2, y + h1 / 2);
			x += config.colWidths[c];
		}

		y += h1;

		// 绘制数据行
		ctx.font = `${config.fontSize}px "Microsoft YaHei", sans-serif`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'middle';

		allBiomes.forEach((biome, biomeIdx) => {
			const rows = biomeRows[biomeIdx];
			const regionHeight = rows * config.cellHeight;

			const exoticInv = invByBiome[biome]?.['Exotic'] || [];
			const exoticMast = mastByBiome[biome]?.['Exotic'] || [];
			const arcaneInv = invByBiome[biome]?.['Arcane'] || [];
			const arcaneMast = mastByBiome[biome]?.['Arcane'] || [];

			// 区域背景
			ctx.fillStyle = config.colors.regionBg;
			ctx.fillRect(0, y, config.colWidths[0], regionHeight);

			// 区域文字（居中）
			ctx.fillStyle = config.colors.text;
			ctx.font = `bold ${config.fontSize + 2}px "Microsoft YaHei", sans-serif`;
			ctx.textAlign = 'center';
			ctx.fillText(biome, config.colWidths[0] / 2, y + regionHeight / 2);
			ctx.font = `${config.fontSize}px "Microsoft YaHei", sans-serif`;
			ctx.textAlign = 'left';

			// 数据行
			for (let i = 0; i < rows; i++) {
				const rowY = y + i * config.cellHeight;
				const textY = rowY + config.cellHeight / 2;

				// 奇异-持有
				if (i < exoticInv.length) {
					const fish = exoticInv[i];
					ctx.fillStyle = config.colors.text;
					ctx.fillText(`${fish.name} ×${fish.qty}`, config.colWidths[0] + config.cellPadding, textY);
				}

				// 奇异-需要
				if (i < exoticMast.length) {
					const fish = exoticMast[i];
					ctx.fillStyle = config.colors.text;
					ctx.fillText(`${fish.name} ×${fish.qty}`, config.colWidths[0] + config.colWidths[1] + config.cellPadding, textY);
				}

				// 奥术-持有
				if (i < arcaneInv.length) {
					const fish = arcaneInv[i];
					ctx.fillStyle = config.colors.text;
					ctx.fillText(`${fish.name} ×${fish.qty}`, config.colWidths[0] + config.colWidths[1] + config.colWidths[2] + config.cellPadding, textY);
				}

				// 奥术-需要
				if (i < arcaneMast.length) {
					const fish = arcaneMast[i];
					ctx.fillStyle = config.colors.text;
					ctx.fillText(`${fish.name} ×${fish.qty}`, config.colWidths[0] + config.colWidths[1] + config.colWidths[2] + config.colWidths[3] + config.cellPadding, textY);
				}

				// 行内细边框
				ctx.strokeStyle = config.colors.border;
				ctx.lineWidth = 0.5;
				for (let c = 0; c < 5; c++) {
					let cx = 0;
					for (let k = 0; k <= c; k++) cx += config.colWidths[k];
					ctx.beginPath();
					ctx.moveTo(cx, rowY);
					ctx.lineTo(cx, rowY + config.cellHeight);
					ctx.stroke();
				}
				ctx.beginPath();
				ctx.moveTo(0, rowY + config.cellHeight);
				ctx.lineTo(totalWidth, rowY + config.cellHeight);
				ctx.stroke();
			}

			// 区域粗边框（顶部和底部）
			ctx.strokeStyle = config.colors.regionBorder;
			ctx.lineWidth = 2;
			// 顶部
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(totalWidth, y);
			ctx.stroke();
			// 底部
			ctx.beginPath();
			ctx.moveTo(0, y + regionHeight);
			ctx.lineTo(totalWidth, y + regionHeight);
			ctx.stroke();

			// 区域左右粗边框
			ctx.beginPath();
			ctx.moveTo(0, y);
			ctx.lineTo(0, y + regionHeight);
			ctx.stroke();
			ctx.beginPath();
			ctx.moveTo(totalWidth, y);
			ctx.lineTo(totalWidth, y + regionHeight);
			ctx.stroke();

			y += regionHeight;
		});

		// 下载图片
		canvas.toBlob((blob) => {
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `Arcane_Angler_换鱼表格_${username.replace(/\s+/g, "_")}_${userId}_${new Date().toISOString().slice(0, 10)}.png`;
			a.click();
			URL.revokeObjectURL(url);
		}, 'image/png');

	}
	async function exportFishImageData() {
		exportFishBiomeMap = exportFishBuildBiomeMap();
		try {
			let username = "玩家";
			let userId = "";
			try {
				const profileResponse = await window.fetch("/api/profile/me", { credentials: "include" });
				if (profileResponse.ok) {
					const profileData = await profileResponse.json();
					const profile = profileData?.profile;
					if (profile) {
						username = String(profile.profile_username ?? "").trim() || "玩家";
						userId = String(profile.id ?? "");
					}
				}
			} catch (e) {}
			let playerData = gameState.getPlayerSnapshot();
			if (!playerData) {
				const savedData = localStorage.getItem("arcaneAnglerSave");
				if (savedData) try { playerData = JSON.parse(savedData); } catch (e) {}
			}
			const inventory = playerData ? exportFishParseInventory(playerData) : [];
			const unlockedBiomes = playerData?.unlockedBiomes || [];
			const allBiomesMasteryData = [];
			const API_BASE = "https://arcaneangler.com/api";
			for (const biomeId of unlockedBiomes) {
				try {
					const response = await window.fetch(`${API_BASE}/mastery/biome/${biomeId}`, { credentials: "include" });
					if (response.ok) {
						const data = await response.json();
						allBiomesMasteryData.push({
							biomeId,
							biomeName: data.biomeName || "Unknown",
							masteryLevel: data.masteryLevel || 0,
							targetFish: data.targetFish || [],
							progress: data.progress || {}
						});
					}
				} catch (e) {}
			}
			const mastery = exportFishParseMastery(allBiomesMasteryData);
			const tableData = exportFishPrepareTableData(inventory, mastery);
			if (!userId && playerData?.userId != null) userId = String(playerData.userId);
			exportFishGenerateImage(tableData, username, userId);
		} catch (e) {
			console.error("[换鱼助手] 导出失败:", e);
			panel?.setStatus("导出失败：" + e.message);
		}
	}

	async function createMarketplaceListingRequest(payload) {
		if (unsafeWindow.ApiService && typeof unsafeWindow.ApiService.createMarketplaceListing === 'function') {
			return unsafeWindow.ApiService.createMarketplaceListing(payload);
		}
		const response = await window.fetch('/api/marketplace/list', {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});
		if (!response.ok) {
			throw new Error('请求失败：' + response.status);
		}
		return response.json();
	}

	function computeAutoSellPrice(rarity, value) {
		if (rarity === 'Mythic') {
			return Math.max(300000, Math.ceil(value / 100000) * 100000);
		}
		return Math.max(20000, Math.ceil(value / 10000) * 10000);
	}

	async function autoSellFish(rarity) {
		const rarityLabel = rarity === 'Mythic' ? '神话' : '传奇';
		try {
			const playerResponse = await window.fetch('/api/player/data', { credentials: 'include' });
			if (!playerResponse.ok) throw new Error('读取背包失败');
			const playerData = await playerResponse.json();
			const inventory = playerData?.inventory || [];
			const fishList = inventory.filter((item) => item.rarity === rarity && !item.isLocked && !item.isFavorite);
			if (!fishList.length) {
				const emptyMessage = '没有可出售的' + rarityLabel + '鱼';
				panel?.setAutoSellStatus(emptyMessage);
				if (typeof unsafeWindow.showToast === 'function') unsafeWindow.showToast(emptyMessage, 'info');
				return { sold: 0, failed: 0 };
			}
			let sold = 0;
			let failed = 0;
			for (let i = 0; i < fishList.length; i++) {
				const item = fishList[i];
				const baseGold = Number(item.baseGold || item.gold) || 0;
				const titanBonus = Number(item.titanBonus) || 1;
				const pricePerUnit = computeAutoSellPrice(rarity, baseGold * titanBonus);
				const quantity = Math.max(1, Math.floor(Number(item.count) || 0));
				const name = item.name || item.fishName || '未知';
				const biomeCode = item.biomeId ? 'B' + item.biomeId : '?';
				const displayName = exportFishGetChineseName(name);
				const priceWan = pricePerUnit / 10000;
				panel?.setAutoSellStatus('正在出售' + rarityLabel + '鱼 ' + (i + 1) + '/' + fishList.length + '：' + biomeCode + ' ' + displayName + ' ' + priceWan + '万');
				try {
					await createMarketplaceListingRequest({ itemType: 'fish', itemId: item.id, pricePerUnit: pricePerUnit, quantity: quantity });
					sold += 1;
				} catch (e) {
					failed += 1;
					console.error('[自动出售鱼] 出售失败:', name, e);
				}
				if (i < fishList.length - 1) {
					await new Promise((resolve) => setTimeout(resolve, 2000 + Math.floor(Math.random() * 1000)));
				}
			}
			const summary = rarityLabel + '鱼出售完成：成功 ' + sold + ' 条，失败 ' + failed + ' 条';
			panel?.setAutoSellStatus(summary);
			if (typeof unsafeWindow.showToast === 'function') unsafeWindow.showToast(summary, sold === fishList.length ? 'success' : 'error');
			return { sold: sold, failed: failed };
		} catch (e) {
			console.error('[自动出售鱼] 出售失败:', e);
			const errorMessage = '出售失败：' + e.message;
			panel?.setAutoSellStatus(errorMessage);
			if (typeof unsafeWindow.showToast === 'function') unsafeWindow.showToast(errorMessage, 'error');
			return { sold: 0, failed: 0 };
		}
	}

	async function copyTextToClipboard(text) {
		const doc = unsafeWindow.document || document;
		const nav = unsafeWindow.navigator || navigator;
		if (nav && nav.clipboard && nav.clipboard.writeText) {
			try {
				await nav.clipboard.writeText(text);
				return true;
			} catch (e) {}
		}
		try {
			const textarea = doc.createElement('textarea');
			textarea.value = text;
			textarea.setAttribute('readonly', '');
			textarea.style.cssText = 'position:fixed;top:-1000px;left:-1000px;';
			doc.body.appendChild(textarea);
			textarea.focus();
			textarea.select();
			textarea.setSelectionRange(0, text.length);
			const ok = doc.execCommand('copy');
			textarea.remove();
			return ok;
		} catch (e) {
			return false;
		}
	}

	async function collectOwnedExoticFish() {
		exportFishBiomeMap = exportFishBuildBiomeMap();
		const items = [];
		const seen = new Set();
		function addFish(biomeId, nameEn) {
			if (!nameEn) return;
			const resolvedBiomeId = Number(biomeId) || exportFishBiomeMap[nameEn]?.biomeId || 0;
			const key = resolvedBiomeId + '_' + nameEn;
			if (seen.has(key)) return;
			seen.add(key);
			items.push({ biomeId: resolvedBiomeId, nameEn: nameEn });
		}
		try {
			const playerResponse = await window.fetch('/api/player/data', { credentials: 'include' });
			if (playerResponse.ok) {
				const playerData = await playerResponse.json();
				(playerData?.inventory || []).forEach((item) => {
					if (item.rarity !== 'Exotic') return;
					addFish(item.biomeId, item.name || item.fishName);
				});
			}
		} catch (e) {}
		try {
			const listingsResponse = await window.fetch('/api/marketplace/my-listings', { credentials: 'include' });
			if (listingsResponse.ok) {
				const listingsData = await listingsResponse.json();
				(listingsData?.listings || []).forEach((listing) => {
					if (listing.item_type !== 'fish') return;
					if (listing.fish_rarity !== 'Exotic') return;
					addFish(listing.fish_biome_id, listing.fish_name);
				});
			}
		} catch (e) {}
		items.sort((a, b) => (a.biomeId - b.biomeId) || String(a.nameEn).localeCompare(String(b.nameEn)));
		return items;
	}

	function formatOwnedExoticFishText(items, lang) {
		if (!items.length) return lang === 'en' ? 'No exotic fish' : '暂无奇异鱼';
		if (lang === 'en') {
			return 'I have ' + items.map((fish) => 'B' + fish.biomeId + ' ' + fish.nameEn).join(', ');
		}
		return '我有' + items.map((fish) => 'B' + fish.biomeId + ' ' + exportFishGetChineseName(fish.nameEn)).join('，');
	}

	async function exportOwnedExoticFish(lang) {
		try {
			const items = await collectOwnedExoticFish();
			const text = formatOwnedExoticFishText(items, lang);
			const copied = await copyTextToClipboard(text);
			const successMessage = lang === 'en' ? '已复制奇异鱼到剪贴板（英文）' : '已复制奇异鱼到剪贴板（中文）';
			if (copied) {
				panel?.setStatus(successMessage);
				if (typeof unsafeWindow.showToast === 'function') unsafeWindow.showToast(successMessage, 'success');
			} else {
				panel?.setStatus('复制失败，请手动复制');
				if (typeof unsafeWindow.showToast === 'function') unsafeWindow.showToast('复制失败，请手动复制', 'error');
			}
			return { copied: copied, items: items, text: text };
		} catch (e) {
			console.error('[换鱼助手] 复制奇异鱼失败:', e);
			const errorMessage = '复制失败：' + e.message;
			panel?.setStatus(errorMessage);
			if (typeof unsafeWindow.showToast === 'function') unsafeWindow.showToast(errorMessage, 'error');
			return { copied: false, items: [], text: '' };
		}
	}

	function initialize() {
		schedule = createScheduleController({
			getCaptcha() {
				return captcha;
			},
			getState() {
				return {
					enabled,
					loopId,
					scheduleSettings
				};
			},
			initialRuntime: loadScheduleRuntime(),
			async onRestTick() {
				if (scheduleSettings.gameAutoFishingDuringRest) return (await gameAutoFishing.ensureActive()).active ? "定时休息中（游戏内置自动钓鱼运行中）" : "定时休息中（等待游戏内置自动钓鱼）";
				return gameAutoFishing.ensureStopped() ? "定时休息中" : "定时休息中（正在停止游戏内置自动钓鱼）";
			},
			onWorkStarted() {
				fishingActivityWatchdog.markFishing();
			},
			onRuntimeChange: saveScheduleRuntime,
			prepareForWork() {
				if (gameAutoFishingSettings.enabled) return true;
				const stopped = gameAutoFishing.ensureStopped();
				if (!stopped) {
					panel?.setStatus("正在停止游戏内置自动钓鱼");
					panel?.setNextDelay("停止后恢复脚本自动钓鱼");
				}
				return stopped;
			},
			renderSettings() {},
			renderStatus(remaining) {},
			setNextDelay(text) {
				panel?.setNextDelay(text);
			},
			setStatus(text) {
				panel?.setStatus(text);
			}
		});
		gameAutoFishing = createGameAutoFishingController({
			onStateChange() {
				panel?.renderGameAutoFishingSettings();
			},
			prepareStart() {
				return autoBait?.prepareGameAutoFishing(gameAutoFishingSettings.baitGrade);
			},
			shouldStart() {
				if (!enabled) return false;
				const snapshot = schedule?.getSnapshot();
				if (scheduleSettings.enabled && snapshot?.schedulePhase === "rest") return scheduleSettings.gameAutoFishingDuringRest && schedule.isRestActive();
				return gameAutoFishingSettings.enabled && !schedule?.isWorkExpired();
			}
		});
		panel = createPanelController({
			actions: {
				resetEarningsStats,
				setAutoBaitGrade,
				setAutoBaitPurchaseSettings,
				setAutoBiomeMasteryXpBonusEnabled,
				setAutoBiomeMaxBiome,
				setAutoBiomePriorityOrder,
				setAutoBiomeWeight,
				setCaptchaBypassEnabled,
				setClickDelaySetting,
				setEnabled,
				setGameAutoFishingEnabled,
				setLoginMonitorEnabled,
				setLoginMonitorConfig
			},
			getState: getPanelState
		});
		captcha = createCaptchaController({
			getCurrentBiome() {
				return gameState.getPlayerSnapshot()?.currentBiome;
			},
			getState() {
				return {
					captchaBypassEnabled,
					enabled
				};
			},
			notify() {
				return sendWeChatHumanVerificationNotification();
			},
			onVerificationResult: recordVerificationResult,
			setEnabled,
			setNextDelay: panel.setNextDelay,
			setStatus: panel.setStatus
		});
		autoBait = createAutoBaitController({
			getPlayer: gameState.getPlayerSnapshot,
			getState: getPanelState,
			onStateChange() {
				panel?.renderAutoBaitSettings();
			}
		});
		autoBoss = createAutoBossController({
			getPlayer: gameState.getPlayerSnapshot,
			getState: getPanelState,
			onStateChange() {
				panel?.renderAutoBossSettings();
			}
		});
		autoBiome = createAutoBiomeController({
			getPlayer: gameState.getPlayerSnapshot,
			getState: getPanelState,
			onBiomeReady(biomeId) {
				const force = forceNextAutoBaitCheck;
				forceNextAutoBaitCheck = false;
				return autoBait?.checkNow({
					biomeId,
					force
				});
			},
			onStateChange() {
				panel?.renderAutoBiomeSettings();
			}
		});
		autoBiome.start();
		for (const response of pendingWeatherResponses.values()) autoBiome.handleWeatherResponse(response);
		pendingWeatherResponses.clear();
		for (const response of pendingCompetitionResponses.values()) if (autoBiome.handleCompetitionResponse(response)) autoBait.handleStateChanged({ force: true });
		pendingCompetitionResponses.clear();
		if (pendingGuildBoosterResponse) {
			autoBiome.handleGuildBoosterResponse(pendingGuildBoosterResponse);
			pendingGuildBoosterResponse = null;
		}
		if (pendingQuestResponse) {
			autoBiome.handleQuestResponse(pendingQuestResponse);
			pendingQuestResponse = null;
		}
		if (pendingCaptchaChallenge) {
			captcha.handleChallenge(pendingCaptchaChallenge);
			pendingCaptchaChallenge = null;
		}
		if (pendingStaffQuestion) {
			captcha.handleStaffQuestion(pendingStaffQuestion);
			pendingStaffQuestion = null;
		}
		setEnabled(enabled, { preserveSchedule: enabled && scheduleSettings.enabled });
		autoBoss.start();
		if (loginMonitorSettings.enabled) startLoginMonitor();
		console.info("[自动抛竿] 脚本已加载，使用右下角按钮控制。");
	}
	if (document.body) initialize();
	else document.addEventListener("DOMContentLoaded", initialize, { once: true });
})();

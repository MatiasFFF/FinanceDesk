import { useEffect, useMemo, useState } from "react";
import { usePeriodLeaveGuard } from "../workspaces/periodNavigation.js";
import {
  ArrowRight,
  CheckCircle,
  CurrencyCircleDollar,
  PencilSimple,
  Plus,
  Receipt,
  WarningCircle,
} from "@phosphor-icons/react";

import { formatCurrency } from "../../productWorkflow.js";
import { useFinanceDesk } from "../../store/FinanceDeskProvider.jsx";
import {
  INVENTORY_MOVEMENT_TYPES,
  INVENTORY_MOVEMENT_TYPE_LABELS,
  buildInventorySummary,
  createInventoryItem,
  createInventoryLossVoucherDraft,
  recordInventoryMovement,
  updateInventoryItem,
  updateInventoryLossVoucherDraft,
} from "./inventoryLedger.js";
import { assessInventoryVoucherIntegrity, inventoryVoucherAmountMatches } from "../evidence/evidenceEngine.js";
import "./inventory-page.css";

const MOVEMENT_TYPES = Object.values(INVENTORY_MOVEMENT_TYPES);
const LOSS_TYPES = new Set([
  INVENTORY_MOVEMENT_TYPES.LOSS,
  INVENTORY_MOVEMENT_TYPES.STOCK_LOSS,
]);
const COST_INPUT_TYPES = new Set([
  INVENTORY_MOVEMENT_TYPES.RECEIPT,
  INVENTORY_MOVEMENT_TYPES.STOCK_GAIN,
]);
const QUANTITY_FORMAT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 });

function periodDate(period) {
  const current = new Date().toISOString().slice(0, 10);
  return current.slice(0, 7) === period ? current : String(period || "") + "-01";
}

function periodEndDate(period) {
  const [year, month] = String(period || "").split("-").map(Number);
  if (!year || !month) return "";
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function defaultLocationId(workspace) {
  return (workspace.stores || []).find((store) => store.status !== "inactive")?.id
    || workspace.stores?.[0]?.id
    || "";
}

function emptyItemForm(workspace) {
  return {
    id: "",
    name: "",
    code: "",
    unit: "",
    openingQuantity: "",
    openingUnitCost: "",
    locationId: defaultLocationId(workspace),
    status: "active",
  };
}

function emptyMovementForm(workspace) {
  const firstItem = (workspace.inventoryItems || []).find((item) => item.status !== "inactive");
  return {
    itemId: firstItem?.id || "",
    type: INVENTORY_MOVEMENT_TYPES.RECEIPT,
    date: periodDate(workspace.currentPeriod),
    quantity: "",
    unitCost: "",
    locationId: firstItem?.locationId || defaultLocationId(workspace),
    reason: "",
    referenceNo: "",
    evidenceIds: [],
  };
}

function formatQuantity(value, unit = "") {
  const number = Number(value || 0);
  return QUANTITY_FORMAT.format(number) + (unit ? " " + unit : "");
}

function documentLabel(document) {
  return document.name || document.title || document.fileName || document.id;
}

function voucherStatusLabel(status) {
  return {
    draft: "草稿待复核",
    changes_requested: "草稿待修订",
    posted: "已复核入账",
    superseded: "历史版本",
  }[status] || "已生成草稿";
}

function Metric({ label, value, note, icon: Icon, tone = "" }) {
  return (
    <article className={"inventory-metric " + tone}>
      <span><Icon size={20} /></span>
      <div><small>{label}</small><strong>{value}</strong><p>{note}</p></div>
    </article>
  );
}

function safeInventoryView(workspace) {
  try {
    const summary = buildInventorySummary(workspace, { period: workspace.currentPeriod });
    const movements = summary.items
      .flatMap((item) => item.movements)
      .sort((left, right) => String(right.date || "").localeCompare(String(left.date || ""))
        || String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
    return { summary, movements, error: "" };
  } catch (error) {
    return {
      summary: {
        items: [],
        totals: {
          receiptAmount: 0,
          issueAmount: 0,
          lossAmount: 0,
          stockLossAmount: 0,
          closingAmount: 0,
        },
      },
      movements: [],
      error: error.message || "库存汇总读取失败",
    };
  }
}

export function InventoryPage({ onPage, onToast }) {
  const { activeWorkspace, actions, state, store } = useFinanceDesk();
  const [itemForm, setItemForm] = useState(() => emptyItemForm(activeWorkspace));
  const [movementForm, setMovementForm] = useState(() => emptyMovementForm(activeWorkspace));
  usePeriodLeaveGuard({ dirty: JSON.stringify(itemForm) !== JSON.stringify(emptyItemForm(activeWorkspace)) || Boolean(movementForm.quantity || movementForm.unitCost || movementForm.reason || movementForm.referenceNo || movementForm.evidenceIds?.length) });
  const [itemFeedback, setItemFeedback] = useState(null);
  const [movementFeedback, setMovementFeedback] = useState(null);
  const [accountingFeedback, setAccountingFeedback] = useState(null);

  const inventoryItems = activeWorkspace.inventoryItems || [];
  const documents = activeWorkspace.documents || [];
  const locations = activeWorkspace.stores || [];
  const actor = activeWorkspace.users?.find((user) => user.id === state.activeUserId)?.name || "本地用户";
  const inventoryView = useMemo(() => safeInventoryView(activeWorkspace), [activeWorkspace]);
  const summary = inventoryView.summary;
  const periodMovements = inventoryView.movements;
  const lossMovements = periodMovements.filter((movement) => LOSS_TYPES.has(movement.type));
  const currentRows = summary.items.map((row) => {
    const item = inventoryItems.find((candidate) => candidate.id === row.itemId);
    const locationNames = [...new Set([
      item?.locationName,
      row.opening?.locationName,
      ...row.movements.map((movement) => movement.locationName),
    ].filter(Boolean))];
    return {
      ...row,
      locationName: locationNames.length > 1 ? locationNames.join(" / ") : (locationNames[0] || "未归属场所"),
    };
  });

  useEffect(() => {
    setItemForm(emptyItemForm(activeWorkspace));
    setMovementForm(emptyMovementForm(activeWorkspace));
    setItemFeedback(null);
    setMovementFeedback(null);
    setAccountingFeedback(null);
  }, [activeWorkspace.id, activeWorkspace.currentPeriod]);

  function saveItem(event) {
    event.preventDefault();
    setItemFeedback(null);
    try {
      const current = store.getActiveWorkspace();
      const editing = Boolean(itemForm.id);
      const next = editing
        ? updateInventoryItem(current, itemForm.id, itemForm, { actor })
        : createInventoryItem(current, itemForm, { actor });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      const saved = editing
        ? next.inventoryItems.find((item) => item.id === itemForm.id)
        : next.inventoryItems.at(-1);
      const differences = assessInventoryVoucherIntegrity(next).issues;
      const message = (editing ? "物料资料已更新" : "物料已新增到当前工作台") + (differences.length ? "；已有损耗凭证成本需更正，原入账金额保留，请在下方按当前成本创建更正" : "");
      setItemFeedback({ tone: "success", message });
      setItemForm(emptyItemForm(next));
      if (saved?.status !== "inactive") {
        setMovementForm((form) => ({
          ...form,
          itemId: saved.id,
          locationId: saved.locationId || form.locationId,
        }));
      }
      onToast?.(message);
    } catch (error) {
      setItemFeedback({ tone: "error", message: error.message || "物料保存失败" });
    }
  }

  function editItem(itemId) {
    const item = inventoryItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setItemFeedback(null);
    setItemForm({
      id: item.id,
      name: item.name || "",
      code: item.code || "",
      unit: item.unit || "",
      openingQuantity: String(item.openingQuantity ?? ""),
      openingUnitCost: String(item.openingUnitCost ?? ""),
      locationId: item.locationId === "unassigned" ? "" : (item.locationId || ""),
      status: item.status || "active",
    });
  }

  function chooseMovementItem(itemId) {
    const item = inventoryItems.find((candidate) => candidate.id === itemId);
    setMovementForm((form) => ({
      ...form,
      itemId,
      locationId: item?.locationId === "unassigned" ? "" : (item?.locationId || form.locationId),
    }));
  }

  function chooseMovementType(type) {
    setMovementForm((form) => ({
      ...form,
      type,
      unitCost: COST_INPUT_TYPES.has(type) ? form.unitCost : "",
    }));
  }

  function toggleEvidence(documentId, checked) {
    setMovementForm((form) => ({
      ...form,
      evidenceIds: checked
        ? [...new Set([...form.evidenceIds, documentId])]
        : form.evidenceIds.filter((id) => id !== documentId),
    }));
  }

  function saveMovement(event) {
    event.preventDefault();
    setMovementFeedback(null);
    try {
      const current = store.getActiveWorkspace();
      const next = recordInventoryMovement(current, {
        itemId: movementForm.itemId,
        type: movementForm.type,
        date: movementForm.date,
        quantity: movementForm.quantity,
        unitCost: movementForm.unitCost,
        locationId: movementForm.locationId,
        reason: movementForm.reason,
        referenceNo: movementForm.referenceNo,
        evidenceIds: movementForm.evidenceIds,
      }, { actor });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      const message = INVENTORY_MOVEMENT_TYPE_LABELS[movementForm.type] + "流水已保存" + (assessInventoryVoucherIntegrity(next).issues.length ? "；已有损耗凭证成本变化，请按当前成本更正后再确认报表" : "");
      setMovementFeedback({ tone: "success", message });
      setMovementForm((form) => ({
        ...emptyMovementForm(next),
        itemId: form.itemId,
        type: form.type,
        date: form.date,
        locationId: form.locationId,
      }));
      onToast?.(message);
    } catch (error) {
      setMovementFeedback({ tone: "error", message: error.message || "库存流水保存失败" });
    }
  }

  function createLossVoucher(movement) {
    setAccountingFeedback(null);
    try {
      const current = store.getActiveWorkspace();
      const existing = (current.vouchers || []).some((voucher) => voucher.inventoryMovementId === movement.id && ["draft", "changes_requested", "posted"].includes(voucher.status));
      const next = existing ? updateInventoryLossVoucherDraft(current, { movementId: movement.id }, { actor }) : createInventoryLossVoucherDraft(current, { movementId: movement.id }, { actor });
      actions.replaceWorkspace(current.id, next, { requiredPermission: "data.write" });
      const voucher = (next.vouchers || []).find((candidate) => candidate.id === next.inventoryMovements.find((item) => item.id === movement.id)?.voucherId);
      const message = (!voucher && existing ? "当前损耗成本为零，未入账草稿已取消" : voucher?.revisionOf ? "成本更正草稿已生成，原凭证继续有效至更正入账" : existing ? "草稿已更新为当前成本" : "手工凭证草稿已生成") + (voucher ? "：" + (voucher.no || voucher.id) : "");
      setAccountingFeedback({ tone: "success", message });
      onToast?.(message);
    } catch (error) {
      setAccountingFeedback({ tone: "error", message: error.message || "损耗凭证草稿生成失败" });
    }
  }

  return (
    <div className="inventory-page">
      <header className="inventory-hero">
        <div>
          <h2>库存与损耗</h2>
          <p>{activeWorkspace.currentPeriod} · 记录入库、领用与盘点差异，按移动加权平均计算成本。</p>
        </div>
      </header>

      {inventoryView.error && <div className="inventory-form-feedback error" role="alert"><WarningCircle size={18} /><span>{inventoryView.error}</span></div>}

      <section className="inventory-metric-grid" aria-label="库存指标">
        <Metric label="库存总额" value={formatCurrency(summary.totals.closingAmount)} note={currentRows.length + " 个物料余额"} icon={CurrencyCircleDollar} />
        <Metric label="本期入库" value={formatCurrency(summary.totals.receiptAmount)} note={periodMovements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.RECEIPT).length + " 笔入库"} icon={Plus} />
        <Metric label="本期领用" value={formatCurrency(summary.totals.issueAmount)} note={periodMovements.filter((movement) => movement.type === INVENTORY_MOVEMENT_TYPES.ISSUE).length + " 笔领用"} icon={Receipt} />
        <Metric label="本期损耗" value={formatCurrency(summary.totals.lossAmount + summary.totals.stockLossAmount)} note={lossMovements.length + " 笔损耗或盘亏"} icon={WarningCircle} tone="loss" />
      </section>

      <div className="inventory-entry-grid">
        <section className="panel inventory-editor-panel">
          <div className="panel-heading">
            <div><h2 className="card-title"><PencilSimple size={18} /><span>{itemForm.id ? "编辑物料" : "新增物料"}</span></h2><p>初始库存只录入一次，后续月份自动承接；已有后续流水时通过盘盈、盘亏调整。</p></div>
          </div>
          <form className={"inventory-form" + (itemForm.id ? " is-editing" : "")} onSubmit={saveItem}>
            <label><span>物料名称 *</span><input required value={itemForm.name} onChange={(event) => setItemForm((form) => ({ ...form, name: event.target.value }))} placeholder="请输入物料名称" /></label>
            <label><span>物料编码</span><input value={itemForm.code} onChange={(event) => setItemForm((form) => ({ ...form, code: event.target.value }))} placeholder="内部编码（可选）" /></label>
            <label><span>单位 *</span><input required value={itemForm.unit} onChange={(event) => setItemForm((form) => ({ ...form, unit: event.target.value }))} placeholder="件、箱、千克等" /></label>
            <label><span>场所</span><select value={itemForm.locationId} onChange={(event) => setItemForm((form) => ({ ...form, locationId: event.target.value }))}><option value="">未归属场所</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name || location.id}{location.status === "inactive" ? "（已停用）" : ""}</option>)}</select></label>
            <label><span>期初数量 *</span><input required min="0" step="any" type="number" value={itemForm.openingQuantity} onChange={(event) => setItemForm((form) => ({ ...form, openingQuantity: event.target.value }))} /></label>
            <label><span>期初单价 *</span><input required min="0" step="0.01" type="number" value={itemForm.openingUnitCost} onChange={(event) => setItemForm((form) => ({ ...form, openingUnitCost: event.target.value }))} /></label>
            <label><span>状态</span><select value={itemForm.status} onChange={(event) => setItemForm((form) => ({ ...form, status: event.target.value }))}><option value="active">启用</option><option value="inactive">停用</option></select></label>
            <div className="inventory-form-actions">
              {itemForm.id && <button className="secondary-button" type="button" onClick={() => setItemForm(emptyItemForm(activeWorkspace))}>取消编辑</button>}
              <button className="primary-button" type="submit"><CheckCircle size={16} />{itemForm.id ? "保存物料修改" : "新增物料"}</button>
            </div>
            {itemFeedback && <p className={"inventory-form-feedback " + itemFeedback.tone} role={itemFeedback.tone === "error" ? "alert" : "status"}>{itemFeedback.tone === "error" ? <WarningCircle size={17} /> : <CheckCircle size={17} weight="fill" />}<span>{itemFeedback.message}</span></p>}
          </form>
        </section>

        <section className="panel inventory-editor-panel">
          <div className="panel-heading">
            <div><h2 className="card-title"><Plus size={18} /><span>记录库存流水</span></h2><p>出库按当时平均成本计价，数量不能超过可用库存。</p></div>
          </div>
          <form className="inventory-form" onSubmit={saveMovement}>
            <label><span>物料 *</span><select required value={movementForm.itemId} onChange={(event) => chooseMovementItem(event.target.value)}><option value="">请先选择物料</option>{inventoryItems.map((item) => <option disabled={item.status === "inactive"} value={item.id} key={item.id}>{item.name}{item.code ? " · " + item.code : ""}{item.status === "inactive" ? "（已停用）" : ""}</option>)}</select></label>
            <label><span>流水类型 *</span><select value={movementForm.type} onChange={(event) => chooseMovementType(event.target.value)}>{MOVEMENT_TYPES.map((type) => <option value={type} key={type}>{INVENTORY_MOVEMENT_TYPE_LABELS[type]}</option>)}</select></label>
            <label><span>日期 *</span><input required min={activeWorkspace.currentPeriod + "-01"} max={periodEndDate(activeWorkspace.currentPeriod)} type="date" value={movementForm.date} onChange={(event) => setMovementForm((form) => ({ ...form, date: event.target.value }))} /></label>
            <label><span>数量 *</span><input required min="0.000001" step="any" type="number" value={movementForm.quantity} onChange={(event) => setMovementForm((form) => ({ ...form, quantity: event.target.value }))} /></label>
            <label><span>入库单价{movementForm.type === INVENTORY_MOVEMENT_TYPES.RECEIPT ? " *" : ""}</span><input disabled={!COST_INPUT_TYPES.has(movementForm.type)} required={movementForm.type === INVENTORY_MOVEMENT_TYPES.RECEIPT} min="0" step="0.01" type="number" value={movementForm.unitCost} onChange={(event) => setMovementForm((form) => ({ ...form, unitCost: event.target.value }))} placeholder={COST_INPUT_TYPES.has(movementForm.type) ? "填写本次单位成本" : "出库时自动计算"} /></label>
            <label><span>场所</span><select value={movementForm.locationId} onChange={(event) => setMovementForm((form) => ({ ...form, locationId: event.target.value }))}><option value="">未归属场所</option>{locations.map((location) => <option value={location.id} key={location.id}>{location.name || location.id}{location.status === "inactive" ? "（已停用）" : ""}</option>)}</select></label>
            <label className="full"><span>原因{LOSS_TYPES.has(movementForm.type) ? " *" : ""}</span><textarea required={LOSS_TYPES.has(movementForm.type)} value={movementForm.reason} onChange={(event) => setMovementForm((form) => ({ ...form, reason: event.target.value }))} placeholder={LOSS_TYPES.has(movementForm.type) ? "说明损耗或盘亏原因" : "补充本次流转原因（可选）"} /></label>
            <label className="full"><span>单据 / 批次号</span><input value={movementForm.referenceNo} onChange={(event) => setMovementForm((form) => ({ ...form, referenceNo: event.target.value }))} placeholder="外部单据号或批次号（可选）" /></label>
            <fieldset className="inventory-document-fieldset">
              <legend>关联资料</legend>
              <div className="inventory-document-options">
                {documents.length ? documents.map((document) => <label key={document.id}><input type="checkbox" checked={movementForm.evidenceIds.includes(document.id)} onChange={(event) => toggleEvidence(document.id, event.target.checked)} /><span><strong>{documentLabel(document)}</strong><small>{document.category || "资料"} · {document.period || "未分期"}</small></span></label>) : <p className="inventory-document-empty">当前工作台还没有可关联资料，可先保存流水。</p>}
              </div>
            </fieldset>
            <div className="inventory-form-actions"><button className="primary-button" disabled={!inventoryItems.some((item) => item.status !== "inactive")} type="submit"><Plus size={16} />保存库存流水</button></div>
            {movementFeedback && <p className={"inventory-form-feedback " + movementFeedback.tone} role={movementFeedback.tone === "error" ? "alert" : "status"}>{movementFeedback.tone === "error" ? <WarningCircle size={17} /> : <CheckCircle size={17} weight="fill" />}<span>{movementFeedback.message}</span></p>}
          </form>
        </section>
      </div>

      <section className="panel inventory-table-panel">
        <div className="panel-heading"><div><h2>当前库存表</h2><p>数量、平均单价与库存金额来自期初和本期全部库存流水。</p></div><span>{currentRows.length} 个物料</span></div>
        {currentRows.length ? <div className="inventory-table inventory-stock-table" role="table" aria-label="当前库存表">
          <div className="inventory-table-row heading" role="row"><span>物料</span><span>场所</span><span>当前数量</span><span>平均单价</span><span>库存金额</span><span>本期流转</span><span>操作</span></div>
          {currentRows.map((row) => <div className="inventory-table-row" role="row" key={row.itemId}>
            <span className="inventory-table-cell" data-label="物料"><strong>{row.name}</strong><small>{row.code || "未设置编码"} · {row.unit}</small></span>
            <span className="inventory-table-cell" data-label="场所"><strong>{row.locationName}</strong><small><span className={"inventory-status-pill " + (row.status === "inactive" ? "inactive" : "")}>{row.status === "inactive" ? "已停用" : "启用"}</span></small></span>
            <span className="inventory-table-cell numeric" data-label="当前数量"><strong>{formatQuantity(row.closing.quantity, row.unit)}</strong><small>期初 {formatQuantity(row.opening.quantity, row.unit)}</small></span>
            <span className="inventory-table-cell numeric" data-label="平均单价"><strong>{formatCurrency(row.closing.averageUnitCost)}</strong><small>移动加权平均</small></span>
            <span className="inventory-table-cell numeric" data-label="库存金额"><strong>{formatCurrency(row.closing.amount)}</strong><small>当前账面余额</small></span>
            <span className="inventory-table-cell numeric" data-label="本期流转"><strong>入 {formatQuantity(row.receipts.quantity + row.stockAdjustments.gain.quantity)}</strong><small>出 {formatQuantity(row.issues.quantity + row.losses.quantity + row.stockAdjustments.loss.quantity)}</small></span>
            <span className="inventory-table-actions"><button className="soft-button" type="button" onClick={() => editItem(row.itemId)}><PencilSimple size={14} />编辑</button></span>
          </div>)}
        </div> : <div className="inventory-table-empty"><Receipt size={24} /><strong>还没有库存物料</strong><p>先在上方新增物料并填写期初数据；保存后会立即进入当前库存表。</p></div>}
      </section>

      <section className="panel inventory-table-panel">
        <div className="panel-heading"><div><h2>本期库存流水</h2></div><span>{periodMovements.length} 笔流水</span></div>
        {accountingFeedback && <p className={"inventory-form-feedback " + accountingFeedback.tone} role={accountingFeedback.tone === "error" ? "alert" : "status"}>{accountingFeedback.tone === "error" ? <WarningCircle size={17} /> : <CheckCircle size={17} weight="fill" />}<span>{accountingFeedback.message}</span></p>}
        {periodMovements.length ? <div className="inventory-table inventory-flow-table" role="table" aria-label="本期库存流水">
          <div className="inventory-table-row heading" role="row"><span>日期</span><span>物料</span><span>类型</span><span>数量</span><span>单位成本</span><span>场所</span><span>原因与来源</span><span>会计处理</span></div>
          {periodMovements.map((movement) => {
            const voucher = (activeWorkspace.vouchers || []).find((candidate) => candidate.id === movement.voucherId);
            const isLoss = LOSS_TYPES.has(movement.type);
            return <div className="inventory-table-row" role="row" key={movement.id}>
              <span className="inventory-table-cell" data-label="日期"><strong>{movement.date}</strong><small>{movement.id}</small></span>
              <span className="inventory-table-cell" data-label="物料"><strong>{movement.itemName}</strong><small>{movement.itemUnit}</small></span>
              <span className="inventory-table-cell" data-label="类型"><span className={"inventory-flow-type " + (isLoss ? "loss" : "")}>{movement.typeLabel || INVENTORY_MOVEMENT_TYPE_LABELS[movement.type]}</span><small>{movement.direction === "in" ? "增加库存" : "减少库存"}</small></span>
              <span className="inventory-table-cell numeric" data-label="数量"><strong>{formatQuantity(movement.quantity, movement.itemUnit)}</strong><small>结余 {formatQuantity(movement.balanceQuantity, movement.itemUnit)}</small></span>
              <span className="inventory-table-cell numeric" data-label="单位成本"><strong>{formatCurrency(movement.unitCost)}</strong><small>金额 {formatCurrency(movement.amount)}</small></span>
              <span className="inventory-table-cell" data-label="场所"><strong>{movement.locationName || "未归属场所"}</strong><small>{movement.locationId}</small></span>
              <span className="inventory-table-cell" data-label="原因与来源"><strong>{movement.reason || "未填写原因"}</strong><small>{[movement.referenceNo, movement.sourceIds?.length ? "关联 " + movement.sourceIds.join("、") : "", `${movement.evidenceIds?.length || 0} 份资料`].filter(Boolean).join(" · ")}</small></span>
              <span className="inventory-table-actions" data-label="会计处理">{isLoss ? (voucher && ["draft", "changes_requested", "posted"].includes(voucher.status) ? <><span className={"inventory-voucher-state " + (voucher.status === "posted" ? "" : "pending")}>{voucherStatusLabel(voucher.status)}</span>{!inventoryVoucherAmountMatches(voucher, movement) && <button className="secondary-button" type="button" onClick={() => createLossVoucher(movement)}>{voucher.status === "posted" ? "按当前成本更正" : "更新为当前成本"}</button>}</> : <button className="secondary-button" type="button" onClick={() => createLossVoucher(movement)}><Receipt size={14} />生成凭证草稿</button>) : <span className="inventory-voucher-state">无需损耗凭证</span>}</span>
            </div>;
          })}
        </div> : <div className="inventory-table-empty"><Receipt size={24} /><strong>本期还没有库存流水</strong><p>新增入库、领用、损耗或盘点记录后，会按日期显示在这里。</p></div>}
        <div className="inventory-accounting-note">
          <span><strong>凭证草稿仍需人工复核</strong><small>损耗或盘亏草稿需核对原件、分录与当前成本后入账。</small></span>
          <button className="secondary-button" type="button" onClick={() => onPage?.("manualVouchers")}>去手工凭证复核<ArrowRight size={16} /></button>
        </div>
      </section>
    </div>
  );
}

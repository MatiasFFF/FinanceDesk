import { useEffect, useId, useRef, useState } from "react";
import { CalendarBlank, CaretDown, CaretLeft, CaretRight, Check, LockSimple } from "@phosphor-icons/react";
import { isPeriodArchived } from "../../domain/periods.js";
import "./accounting-period-picker.css";

const MIN_YEAR = 1900;
const MAX_YEAR = 9999;
const months = Array.from({ length: 12 }, (_, index) => index + 1);

export function AccountingPeriodPicker({ workspace, disabled = false, onSelect }) {
  const [open, setOpen] = useState(false);
  const [yearInput, setYearInput] = useState(workspace.currentPeriod.slice(0, 4));
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelId = useId();
  const currentYear = workspace.currentPeriod.slice(0, 4);
  const currentMonth = Number(workspace.currentPeriod.slice(5, 7));
  const year = Number(yearInput);
  const validYear = /^\d{4}$/.test(yearInput) && year >= MIN_YEAR && year <= MAX_YEAR;
  const archived = isPeriodArchived(workspace);

  useEffect(() => {
    setOpen(false);
    setYearInput(workspace.currentPeriod.slice(0, 4));
  }, [workspace.id, workspace.currentPeriod, disabled]);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      rootRef.current?.querySelector('[data-period-current="true"]')?.focus();
    });
    function closeOnOutsidePointer(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function selectMonth(month) {
    if (!validYear) return;
    const period = `${yearInput}-${String(month).padStart(2, "0")}`;
    if (onSelect(period) === false) return;
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveMonthFocus(event, index) {
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 };
    const next = event.key === "Home" ? 0 : event.key === "End" ? 11 : index + (steps[event.key] ?? 0);
    if (!(event.key in steps) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    rootRef.current?.querySelectorAll("[data-period-month]")[Math.max(0, Math.min(11, next))]?.focus();
  }

  return (
    <div className="accounting-period-picker" ref={rootRef} onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <button
        ref={triggerRef}
        className={`accounting-period-trigger${open ? " is-open" : ""}`}
        type="button"
        disabled={disabled}
        aria-label={`选择活动账期，当前 ${currentYear} 年 ${currentMonth} 月${archived ? "，已归档，只读" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => { setYearInput(currentYear); setOpen((value) => !value); }}
      >
        <CalendarBlank size={17} aria-hidden="true" />
        <span>{currentYear} 年 {currentMonth} 月</span>
        {archived && <span className="accounting-period-readonly">只读</span>}
        <CaretDown className="accounting-period-caret" size={13} aria-hidden="true" />
      </button>
      {open && <div className="accounting-period-panel" id={panelId} role="dialog" aria-label="选择账期">
        <div className="accounting-period-panel-heading">
          <span>选择账期</span>
          <div className="accounting-period-year-nav">
            <button type="button" aria-label="上一年" disabled={!validYear || year <= MIN_YEAR} onClick={() => setYearInput(String(year - 1))}><CaretLeft size={16} /></button>
            <label className="accounting-period-year"><input aria-label="账期年份" type="text" inputMode="numeric" maxLength={4} value={yearInput} aria-invalid={!validYear} onChange={(event) => setYearInput(event.target.value.replace(/\D/g, ""))} /><span>年</span></label>
            <button type="button" aria-label="下一年" disabled={!validYear || year >= MAX_YEAR} onClick={() => setYearInput(String(year + 1))}><CaretRight size={16} /></button>
          </div>
        </div>
        {!validYear && <p className="accounting-period-error" role="alert">请输入 {MIN_YEAR}–{MAX_YEAR} 年</p>}
        <div className="accounting-period-months" role="group" aria-label="月份">
          {months.map((month, index) => {
            const period = `${yearInput}-${String(month).padStart(2, "0")}`;
            const selected = period === workspace.currentPeriod;
            const closed = validYear && isPeriodArchived(workspace, period);
            return <button key={month} type="button" disabled={!validYear} className={`accounting-period-month${selected ? " is-current" : ""}`} aria-pressed={selected} aria-label={`${yearInput} 年 ${month} 月${closed ? "，已归档，只读" : ""}`} data-period-month data-period-current={selected} onClick={() => selectMonth(month)} onKeyDown={(event) => moveMonthFocus(event, index)}>
              <span>{month} 月</span>
              {closed ? <LockSimple size={13} aria-hidden="true" /> : selected ? <Check size={13} weight="bold" aria-hidden="true" /> : null}
            </button>;
          })}
        </div>
        <div className="accounting-period-panel-footer">
          <span><LockSimple size={12} aria-hidden="true" />已归档月份只读</span>
          {yearInput !== currentYear && <button type="button" onClick={() => setYearInput(currentYear)}>返回 {currentYear} 年</button>}
        </div>
      </div>}
    </div>
  );
}

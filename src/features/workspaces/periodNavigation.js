import { useEffect } from "react";

export function usePeriodLeaveGuard({ dirty = false, busy = false } = {}) {
  useEffect(() => {
    function beforeChange(event) {
      if (typeof busy === "function" ? busy() : busy) event.detail.busy = true;
      if (dirty) event.detail.dirty = true;
    }
    window.addEventListener("financedesk:before-period-change", beforeChange);
    return () => window.removeEventListener("financedesk:before-period-change", beforeChange);
  }, [dirty, busy]);
}

export function allowPeriodNavigation() {
  const detail = { busy: false, dirty: false };
  window.dispatchEvent(new CustomEvent("financedesk:before-period-change", { detail }));
  if (detail.busy) throw new Error("当前有资料保存或识别任务正在进行，请完成或取消后再切换账期");
  return !detail.dirty || window.confirm("当前有尚未保存的编辑或导入内容。确定放弃这些内容并切换账期吗？取消后可以先保存。");
}

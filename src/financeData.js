export const APP_STORAGE_KEY = "shanlan-finance-workbench-v3";

export const ACCOUNT_LABELS = {
  bank: "银行存款",
  cash: "库存现金",
  receivable: "应收账款",
  prepayment: "预付账款",
  equipment: "固定资产",
  payable: "应付账款",
  contractLiability: "合同负债",
  equity: "实收资本 / 所有者权益",
  revenuePrivate: "主营业务收入 · 私教课",
  revenueGroup: "主营业务收入 · 团课",
  expenseRent: "管理费用 · 房租",
  expenseUtility: "管理费用 · 水电费",
  expenseFee: "财务费用 · 手续费",
  expenseCommission: "销售费用 · 教练提成",
  expenseOther: "管理费用 · 其他",
};

export const NAV_GROUPS = [
  {
    label: "经营",
    items: [
      { id: "overview", label: "月度总览" },
      { id: "business", label: "业务台账" },
    ],
  },
  {
    label: "核算",
    items: [
      { id: "reconcile", label: "流水核销" },
      { id: "balances", label: "往来款" },
      { id: "vouchers", label: "凭证中心" },
    ],
  },
  {
    label: "交付",
    items: [
      { id: "reports", label: "报表中心" },
      { id: "tax", label: "税务确认" },
      { id: "documents", label: "资料档案" },
    ],
  },
];

const demoDocuments = [
  {
    id: "doc-bank-aug",
    name: "招商银行 8 月流水.xlsx",
    type: "银行流水",
    size: 48210,
    status: "已归档",
    period: "2026-08",
    relatedIds: ["bank-cmb-8821"],
    createdAt: "2026-09-01T09:12:00.000Z",
    hash: "demo-bank-aug",
  },
  {
    id: "doc-meituan-settle",
    name: "美团平台 8 月结算单.pdf",
    type: "平台账单",
    size: 238400,
    status: "已归档",
    period: "2026-08",
    relatedIds: ["bill-ar-meituan-a", "bill-ar-meituan-b", "txn-meituan"],
    createdAt: "2026-09-01T09:18:00.000Z",
    hash: "demo-meituan",
  },
  {
    id: "doc-li-contract",
    name: "李女士私教会员协议.pdf",
    type: "合同",
    size: 168020,
    status: "已归档",
    period: "2026-08",
    relatedIds: ["member-li", "bill-deposit-li", "txn-li"],
    createdAt: "2026-08-25T11:30:00.000Z",
    hash: "demo-li-contract",
  },
  {
    id: "doc-power-invoice",
    name: "8 月电费电子发票.pdf",
    type: "发票",
    size: 98500,
    status: "已归档",
    period: "2026-08",
    relatedIds: ["txn-power"],
    createdAt: "2026-08-13T08:42:00.000Z",
    hash: "demo-power",
  },
  {
    id: "doc-equipment-order",
    name: "力量器械采购单.pdf",
    type: "采购单",
    size: 112540,
    status: "已归档",
    period: "2026-08",
    relatedIds: ["bill-ap-equipment", "txn-equipment"],
    createdAt: "2026-08-22T15:20:00.000Z",
    hash: "demo-equipment-order",
  },
];

const demoBills = [
  {
    id: "bill-ar-meituan-a",
    no: "YS-202608-001",
    kind: "receivable",
    counterparty: "美团平台",
    summary: "8 月上半月团课结算",
    amount: 800,
    date: "2026-08-15",
    dueDate: "2026-08-25",
    evidenceIds: ["doc-meituan-settle"],
    source: "平台结算",
  },
  {
    id: "bill-ar-meituan-b",
    no: "YS-202608-002",
    kind: "receivable",
    counterparty: "美团平台",
    summary: "8 月下半月团课结算",
    amount: 1156,
    date: "2026-08-22",
    dueDate: "2026-08-31",
    evidenceIds: ["doc-meituan-settle"],
    source: "平台结算",
  },
  {
    id: "bill-ar-company",
    no: "YS-202608-003",
    kind: "receivable",
    counterparty: "云杉科技",
    summary: "企业团建课程",
    amount: 3600,
    date: "2026-08-28",
    dueDate: "2026-09-10",
    evidenceIds: [],
    source: "企业客户",
  },
  {
    id: "bill-ap-equipment",
    no: "YF-202608-001",
    kind: "payable",
    counterparty: "力盛器械",
    summary: "力量器械采购",
    amount: 3680,
    date: "2026-08-22",
    dueDate: "2026-08-25",
    evidenceIds: ["doc-equipment-order"],
    source: "采购",
  },
  {
    id: "bill-ap-rent",
    no: "YF-202608-002",
    kind: "payable",
    counterparty: "山岚商业管理",
    summary: "8 月场地租金",
    amount: 6800,
    date: "2026-08-01",
    dueDate: "2026-08-10",
    evidenceIds: [],
    source: "费用",
  },
  {
    id: "bill-deposit-li",
    no: "YS-202608-101",
    kind: "depositReceived",
    counterparty: "李女士",
    summary: "私教课 20 节预收",
    amount: 4800,
    date: "2026-08-25",
    dueDate: "2026-08-25",
    evidenceIds: ["doc-li-contract"],
    source: "会员充值",
  },
  {
    id: "bill-deposit-wang",
    no: "YS-202608-102",
    kind: "depositReceived",
    counterparty: "王先生",
    summary: "私教课 10 节预收",
    amount: 2400,
    date: "2026-08-23",
    dueDate: "2026-08-23",
    evidenceIds: [],
    source: "会员充值",
  },
  {
    id: "bill-prepay-rent",
    no: "YF-202608-101",
    kind: "prepaymentPaid",
    counterparty: "山岚商业管理",
    summary: "9 月场地租金预付",
    amount: 6800,
    date: "2026-08-24",
    dueDate: "2026-08-24",
    evidenceIds: [],
    source: "费用预付",
  },
];

const demoTransactions = [
  {
    id: "txn-meituan",
    accountId: "bank-cmb-8821",
    date: "2026-08-26",
    counterparty: "美团平台商户",
    summary: "团课结算款",
    amount: 1286,
    serial: "2026082600123",
    suggestion: "团课收入回款",
    confidence: 96,
    evidenceIds: ["doc-meituan-settle"],
    allocations: [
      { billId: "bill-ar-meituan-a", amount: 800 },
      { billId: "bill-ar-meituan-b", amount: 486 },
    ],
    status: "reconciled",
    reviewedAt: "2026-08-27T09:05:00.000Z",
  },
  {
    id: "txn-meituan-2",
    accountId: "bank-cmb-8821",
    date: "2026-08-29",
    counterparty: "美团平台商户",
    summary: "团课结算款补款",
    amount: 670,
    serial: "2026082900118",
    suggestion: "团课收入回款",
    confidence: 98,
    evidenceIds: ["doc-meituan-settle"],
    allocations: [{ billId: "bill-ar-meituan-b", amount: 670 }],
    status: "reconciled",
    reviewedAt: "2026-08-30T09:05:00.000Z",
  },
  {
    id: "txn-li",
    accountId: "bank-cmb-8821",
    date: "2026-08-25",
    counterparty: "会员李女士",
    summary: "私教课预收 · 20 节",
    amount: 4800,
    serial: "2026082500891",
    suggestion: "会员预收款",
    confidence: 97,
    evidenceIds: ["doc-li-contract"],
    allocations: [{ billId: "bill-deposit-li", amount: 4800 }],
    status: "reconciled",
    reviewedAt: "2026-08-25T14:20:00.000Z",
  },
  {
    id: "txn-fee",
    accountId: "bank-cmb-8821",
    date: "2026-08-24",
    counterparty: "拉卡拉支付",
    summary: "收单手续费",
    amount: -12.8,
    serial: "2026082403407",
    suggestion: "支付手续费",
    directAccount: "expenseFee",
    confidence: 99,
    evidenceIds: [],
    allocations: [],
    status: "reconciled",
    reviewedAt: "2026-08-24T17:05:00.000Z",
  },
  {
    id: "txn-wang",
    accountId: "bank-cmb-8821",
    date: "2026-08-23",
    counterparty: "会员王先生",
    summary: "私教课预收 · 10 节",
    amount: 2400,
    serial: "2026082300428",
    suggestion: "会员预收款",
    confidence: 90,
    evidenceIds: [],
    allocations: [{ billId: "bill-deposit-wang", amount: 2400 }],
    status: "exception",
    exceptionReason: "缺少会员协议",
  },
  {
    id: "txn-equipment",
    accountId: "bank-cmb-8821",
    date: "2026-08-23",
    counterparty: "力盛器械",
    summary: "力量器械采购",
    amount: -3680,
    serial: "2026082300572",
    suggestion: "固定资产采购付款",
    confidence: 86,
    evidenceIds: ["doc-equipment-order"],
    allocations: [{ billId: "bill-ap-equipment", amount: 3680 }],
    status: "exception",
    exceptionReason: "缺少采购发票与审批记录",
  },
  {
    id: "txn-zhang",
    accountId: "bank-cmb-8821",
    date: "2026-08-20",
    counterparty: "会员张女士",
    summary: "瑜伽小班课收款",
    amount: 299,
    serial: "2026082000719",
    suggestion: "团课收入",
    directAccount: "revenueGroup",
    confidence: 78,
    evidenceIds: [],
    allocations: [],
    status: "exception",
    exceptionReason: "匹配置信度低于规则阈值，缺少课程签到",
  },
  {
    id: "txn-private",
    accountId: "bank-cmb-8821",
    date: "2026-08-16",
    counterparty: "会员刘先生",
    summary: "私教课收入 · 6 节",
    amount: 1440,
    serial: "2026081600168",
    suggestion: "私教课收入",
    directAccount: "revenuePrivate",
    confidence: 97,
    evidenceIds: [],
    allocations: [],
    status: "reconciled",
    reviewedAt: "2026-08-17T10:12:00.000Z",
  },
  {
    id: "txn-wechat",
    accountId: "bank-cmb-8821",
    date: "2026-08-14",
    counterparty: "微信支付",
    summary: "团课聚合收款",
    amount: 816,
    serial: "2026081400912",
    suggestion: "团课收入",
    directAccount: "revenueGroup",
    confidence: 95,
    evidenceIds: [],
    allocations: [],
    status: "reconciled",
    reviewedAt: "2026-08-15T10:12:00.000Z",
  },
  {
    id: "txn-power",
    accountId: "bank-cmb-8821",
    date: "2026-08-12",
    counterparty: "国家电网",
    summary: "工作室电费",
    amount: -320.5,
    serial: "2026081200286",
    suggestion: "水电费",
    directAccount: "expenseUtility",
    confidence: 99,
    evidenceIds: ["doc-power-invoice"],
    allocations: [],
    status: "reconciled",
    reviewedAt: "2026-08-13T10:12:00.000Z",
  },
  {
    id: "txn-unknown",
    accountId: "bank-cmb-8821",
    date: "2026-08-09",
    counterparty: "个人转账",
    summary: "转账",
    amount: 1000,
    serial: "2026080900191",
    suggestion: "待确认",
    confidence: 31,
    evidenceIds: [],
    allocations: [],
    status: "exception",
    exceptionReason: "无法识别业务用途",
  },
];

const demoBusinessEvents = [
  { id: "event-recharge-li", type: "recharge", date: "2026-08-25", memberId: "member-li", memberName: "李女士", amount: 4800, quantity: 20, coach: "陈教练", billId: "bill-deposit-li", note: "20 节私教课充值" },
  { id: "event-recharge-wang", type: "recharge", date: "2026-08-23", memberId: "member-wang", memberName: "王先生", amount: 2400, quantity: 10, coach: "陈教练", billId: "bill-deposit-wang", note: "10 节私教课充值" },
  { id: "event-consume-li-1", type: "consume", date: "2026-08-27", memberId: "member-li", memberName: "李女士", amount: 240, quantity: 1, coach: "陈教练", note: "私教课签到并确认收入" },
  { id: "event-consume-li-2", type: "consume", date: "2026-08-30", memberId: "member-li", memberName: "李女士", amount: 240, quantity: 1, coach: "陈教练", note: "私教课签到并确认收入" },
  { id: "event-refund", type: "refund", date: "2026-08-28", memberId: "member-zhao", memberName: "赵女士", amount: 600, quantity: 2, coach: "", note: "剩余 2 节课程退款，待付款" },
  { id: "event-commission", type: "commission", date: "2026-08-31", memberId: "", memberName: "陈教练", amount: 1440, quantity: 12, coach: "陈教练", note: "8 月私教课提成" },
];

const postedVouchers = [
  {
    id: "voucher-001",
    no: "记-001",
    date: "2026-08-12",
    summary: "支付工作室电费",
    status: "posted",
    sourceIds: ["txn-power"],
    evidenceIds: ["doc-power-invoice"],
    lines: [
      { account: "expenseUtility", debit: 320.5, credit: 0 },
      { account: "bank", debit: 0, credit: 320.5 },
    ],
    createdAt: "2026-08-13T10:15:00.000Z",
  },
  {
    id: "voucher-002",
    no: "记-002",
    date: "2026-08-14",
    summary: "确认团课聚合收款",
    status: "posted",
    sourceIds: ["txn-wechat"],
    evidenceIds: [],
    lines: [
      { account: "bank", debit: 816, credit: 0 },
      { account: "revenueGroup", debit: 0, credit: 816 },
    ],
    createdAt: "2026-08-15T10:15:00.000Z",
  },
  {
    id: "voucher-003",
    no: "记-003",
    date: "2026-08-16",
    summary: "确认私教课收入",
    status: "posted",
    sourceIds: ["txn-private"],
    evidenceIds: [],
    lines: [
      { account: "bank", debit: 1440, credit: 0 },
      { account: "revenuePrivate", debit: 0, credit: 1440 },
    ],
    createdAt: "2026-08-17T10:15:00.000Z",
  },
  {
    id: "voucher-004",
    no: "记-004",
    date: "2026-08-25",
    summary: "收到李女士私教课预收款",
    status: "posted",
    sourceIds: ["txn-li", "bill-deposit-li"],
    evidenceIds: ["doc-li-contract"],
    lines: [
      { account: "bank", debit: 4800, credit: 0 },
      { account: "contractLiability", debit: 0, credit: 4800 },
    ],
    createdAt: "2026-08-25T14:25:00.000Z",
  },
  {
    id: "voucher-005",
    no: "记-005",
    date: "2026-08-26",
    summary: "收到美团平台结算款",
    status: "posted",
    sourceIds: ["txn-meituan", "bill-ar-meituan-a", "bill-ar-meituan-b"],
    evidenceIds: ["doc-meituan-settle"],
    lines: [
      { account: "bank", debit: 1286, credit: 0 },
      { account: "receivable", debit: 0, credit: 1286 },
    ],
    createdAt: "2026-08-27T09:08:00.000Z",
  },
  {
    id: "voucher-006",
    no: "记-006",
    date: "2026-08-27",
    summary: "李女士私教课消课确认收入",
    status: "posted",
    sourceIds: ["event-consume-li-1"],
    evidenceIds: ["doc-li-contract"],
    lines: [
      { account: "contractLiability", debit: 240, credit: 0 },
      { account: "revenuePrivate", debit: 0, credit: 240 },
    ],
    createdAt: "2026-08-27T20:10:00.000Z",
  },
];

export function createDemoWorkspace() {
  return {
    id: "workspace-shanlan",
    name: "山岚健身工作室",
    templateLabel: "健身工作室样例",
    isDemo: true,
    company: {
      legalName: "山岚健身服务（上海）有限公司",
      taxId: "91310000MA8DEMO001",
      industry: "私教健身工作室",
      taxpayerType: "小规模纳税人",
      ownerName: "林岚",
    },
    currentPeriod: "2026-08",
    periods: ["2026-08", "2026-07"],
    rules: {
      confidenceThreshold: 85,
      requireEvidenceForExpense: true,
      autoDraftVoucher: false,
      categoryKeywords: [
        { keyword: "电费|国家电网", account: "expenseUtility" },
        { keyword: "手续费|拉卡拉", account: "expenseFee" },
        { keyword: "私教", account: "revenuePrivate" },
        { keyword: "团课|美团|微信支付", account: "revenueGroup" },
      ],
    },
    users: [
      { id: "user-accountant", name: "周会计", role: "财务负责人" },
      { id: "user-owner", name: "林岚", role: "经营者" },
    ],
    accounts: [
      { id: "bank-cmb-8821", name: "招商银行（8821）", openingBalance: 50000, statementClosing: 58073.7, currency: "CNY" },
    ],
    members: [
      { id: "member-li", name: "李女士", phone: "138****2187", coach: "陈教练", status: "在籍" },
      { id: "member-wang", name: "王先生", phone: "136****4062", coach: "陈教练", status: "在籍" },
      { id: "member-zhao", name: "赵女士", phone: "139****1750", coach: "宋教练", status: "退款中" },
    ],
    businessEvents: demoBusinessEvents,
    bills: demoBills,
    transactions: demoTransactions,
    documents: demoDocuments,
    vouchers: postedVouchers,
    openingLedger: {
      bank: 50000,
      receivable: 4200,
      prepayment: 2000,
      equipment: 30000,
      payable: -6000,
      contractLiability: -12000,
      equity: -68200,
    },
    tax: {
      period: "2026-08",
      adjustments: 0,
      payroll: 28600,
      socialSecurity: 6200,
      note: "",
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
    },
    auditLog: [
      { id: "log-001", at: "2026-09-01T09:12:00.000Z", actor: "周会计", action: "导入银行流水", detail: "招商银行 8 月流水，共 11 笔" },
      { id: "log-002", at: "2026-09-01T09:18:00.000Z", actor: "周会计", action: "归档资料", detail: "美团平台 8 月结算单.pdf" },
    ],
  };
}

export function createBlankWorkspace({ name, legalName, industry, taxpayerType, mode = "blank" }) {
  const id = `workspace-${Date.now()}`;
  const base = mode === "template" ? createDemoWorkspace() : null;
  if (base) {
    return {
      ...base,
      id,
      name,
      templateLabel: "由山岚模板创建",
      isDemo: false,
      company: { ...base.company, legalName: legalName || name, industry, taxpayerType, ownerName: "" },
      auditLog: [{ id: `log-${Date.now()}`, at: new Date().toISOString(), actor: "周会计", action: "创建账套", detail: `从健身工作室模板创建「${name}」` }],
    };
  }

  return {
    id,
    name,
    templateLabel: "空白账套",
    isDemo: false,
    company: { legalName: legalName || name, taxId: "", industry, taxpayerType, ownerName: "" },
    currentPeriod: new Date().toISOString().slice(0, 7),
    periods: [new Date().toISOString().slice(0, 7)],
    rules: {
      confidenceThreshold: 85,
      requireEvidenceForExpense: true,
      autoDraftVoucher: false,
      categoryKeywords: [],
    },
    users: [{ id: "user-accountant", name: "周会计", role: "财务负责人" }],
    accounts: [],
    members: [],
    businessEvents: [],
    bills: [],
    transactions: [],
    documents: [],
    vouchers: [],
    openingLedger: { bank: 0, receivable: 0, prepayment: 0, equipment: 0, payable: 0, contractLiability: 0, equity: 0 },
    tax: {
      period: new Date().toISOString().slice(0, 7),
      adjustments: 0,
      payroll: 0,
      socialSecurity: 0,
      note: "",
      frozenAt: null,
      financeConfirmedAt: null,
      payrollConfirmedAt: null,
      ownerConfirmedAt: null,
      confirmedBy: "",
    },
    auditLog: [{ id: `log-${Date.now()}`, at: new Date().toISOString(), actor: "周会计", action: "创建账套", detail: `创建空白账套「${name}」` }],
  };
}

export function initialAppState() {
  return {
    version: 3,
    activeWorkspaceId: "workspace-shanlan",
    activeUserId: "user-accountant",
    workspaces: [createDemoWorkspace()],
  };
}

export function uid(prefix = "item") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function allocatedForBill(workspace, billId) {
  return roundMoney(workspace.transactions.reduce((total, transaction) => {
    return total + (transaction.allocations || [])
      .filter((allocation) => allocation.billId === billId)
      .reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0);
  }, 0));
}

export function allocatedForTransaction(transaction) {
  return roundMoney((transaction.allocations || []).reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0));
}

export function billBalance(workspace, bill) {
  return roundMoney(Number(bill.amount || 0) - allocatedForBill(workspace, bill.id));
}

export function statementMetrics(workspace) {
  const balances = { ...workspace.openingLedger };
  Object.keys(ACCOUNT_LABELS).forEach((account) => {
    if (balances[account] == null) balances[account] = 0;
  });

  workspace.vouchers
    .filter((voucher) => voucher.status === "posted")
    .forEach((voucher) => voucher.lines.forEach((line) => {
      balances[line.account] = roundMoney((balances[line.account] || 0) + Number(line.debit || 0) - Number(line.credit || 0));
    }));

  const revenue = roundMoney(-(balances.revenuePrivate + balances.revenueGroup));
  const expenses = roundMoney(balances.expenseRent + balances.expenseUtility + balances.expenseFee + balances.expenseCommission + balances.expenseOther);
  const profit = roundMoney(revenue - expenses);
  const assets = roundMoney(balances.bank + balances.cash + balances.receivable + balances.prepayment + balances.equipment);
  const liabilities = roundMoney(-(balances.payable + balances.contractLiability));
  const equity = roundMoney(-balances.equity + profit);
  return { balances, revenue, expenses, profit, assets, liabilities, equity, difference: roundMoney(assets - liabilities - equity) };
}

export function bankMetrics(workspace, account) {
  const movement = roundMoney(workspace.transactions
    .filter((transaction) => transaction.accountId === account.id)
    .reduce((sum, transaction) => sum + Number(transaction.amount || 0), 0));
  const bookClosing = roundMoney(Number(account.openingBalance || 0) + movement);
  const difference = roundMoney(Number(account.statementClosing || 0) - bookClosing);
  return { movement, bookClosing, difference };
}

export function businessTypeLabel(type) {
  return {
    recharge: "会员充值",
    consume: "课程消耗",
    refund: "会员退款",
    commission: "教练提成",
  }[type] || type;
}

export function billKindLabel(kind) {
  return {
    receivable: "应收款",
    payable: "应付款",
    depositReceived: "预收款",
    prepaymentPaid: "预付款",
  }[kind] || kind;
}

export function transactionStatus(transaction) {
  if (transaction.status === "ignored") return { label: "暂不处理", tone: "neutral" };
  if (transaction.status === "posted") return { label: "已入账", tone: "success" };
  if (transaction.status === "reconciled") return { label: "已核销", tone: "success" };
  if (transaction.status === "exception") return { label: "有异常", tone: "danger" };
  const allocated = allocatedForTransaction(transaction);
  if (allocated > 0 && allocated < Math.abs(transaction.amount)) return { label: "部分核销", tone: "warning" };
  return { label: "待核销", tone: "warning" };
}

export function closeReadiness(workspace) {
  const periodTransactions = workspace.transactions.filter((item) => item.date.startsWith(workspace.currentPeriod));
  const exceptions = periodTransactions.filter((item) => item.status === "exception" || item.status === "pending");
  const drafts = workspace.vouchers.filter((voucher) => voucher.status === "draft");
  const bankOk = workspace.accounts.length > 0 && workspace.accounts.every((account) => Math.abs(bankMetrics(workspace, account).difference) < 0.01);
  const statements = statementMetrics(workspace);
  const steps = [
    { id: "documents", label: "资料归集", done: workspace.documents.length > 0 || periodTransactions.length === 0, page: "documents" },
    { id: "bank", label: "银行对账", done: bankOk, page: "reconcile" },
    { id: "reconcile", label: "流水核销", done: exceptions.length === 0, page: "reconcile" },
    { id: "vouchers", label: "凭证复核", done: drafts.length === 0 && workspace.vouchers.length > 0, page: "vouchers" },
    { id: "reports", label: "三表校验", done: Math.abs(statements.difference) < 0.01 && workspace.vouchers.length > 0, page: "reports" },
    { id: "confirm", label: "客户确认", done: Boolean(workspace.tax.ownerConfirmedAt), page: "tax" },
  ];
  return { steps, completed: steps.filter((step) => step.done).length, exceptions, bankOk, statements };
}

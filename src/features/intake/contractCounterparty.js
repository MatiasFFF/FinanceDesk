const nameKey = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");

export function resolveContractCounterparty(workspace, details = {}) {
  const selection = details.counterpartyParty || "auto";
  const companyName = String(workspace.company?.legalName || "").trim();
  const names = { partyA: String(details.partyA || "").trim(), partyB: String(details.partyB || "").trim() };
  const isCompany = (party) => Boolean(companyName && names[party] && nameKey(names[party]) === nameKey(companyName));
  const errors = [];
  let party = null;
  if (!["auto", "partyA", "partyB"].includes(selection)) errors.push("请选择自动识别、甲方或乙方作为往来对方");
  else if (selection !== "auto") party = selection;
  else if (isCompany("partyA") !== isCompany("partyB")) party = isCompany("partyA") ? "partyB" : "partyA";
  else errors.push("无法根据当前企业名称明确合同往来对方，请核对甲乙方后手动选择");
  if (party && !names[party]) errors.push("所选往来对方名称为空，请补全合同甲乙方");
  if (party && isCompany(party)) errors.push("不能将当前企业本身选为合同往来对方");
  return {
    counterparty: errors.length ? "" : names[party], party, selection, errors,
    source: { kind: selection === "auto" ? "company_name_match" : "manual", companyName, ...names, selectedParty: party },
  };
}

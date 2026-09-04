# Design QA

## 比较目标

- source visual truth path: `/Users/matias/Project/FinanceDesk/design-reference.png`
- implementation screenshot path: `/Users/matias/Project/FinanceDesk/implementation-reconcile-final.png`
- responsive evidence: `/Users/matias/Project/FinanceDesk/implementation-mobile-final.png`
- viewport: `1487 × 1058` CSS px（桌面核销工作台）；`390 × 844` CSS px（窄屏核销列表）
- source pixels: `1487 × 1058`
- implementation pixels: `1487 × 1058`
- CSS size: `1487 × 1058`
- device density normalization: 源图与实现截图像素尺寸和 CSS 视口一致，按 `1×` 比较，无缩放归一化
- state: 2026 年 8 月演示账套，核销工作台，首笔流水选中，右侧证据详情展开

## Full-view comparison evidence

源图与最终实现已在同一次图像比较输入中打开，使用相同视口、页面状态和暖色主题进行对照。实现保留了目标中的左侧导航、六阶段进度、批量流水表、橙色选中态、绿色证据状态和右侧单笔详情。为了把三个已选方向合为一个系统，实现额外保留了较明确的页面标题区；这是信息架构选择，不影响核销主任务。

## Focused region comparison evidence

未单独裁切局部区域。原始 `1487 × 1058` 对照中，侧栏、表格文字、证据区、状态标签和底部操作按钮均可辨认；全尺寸视图已经足以判断关键细节。另以 `390 × 844` 独立截图检查了窄屏列表与单笔详情切换。

## Required fidelity surfaces

- 字体与排版：中文标题使用系统宋体回退，正文使用 Mac/Windows 系统无衬线字体；标题、辅助文字和金额层级清晰，无关键文本截断。
- 间距与布局：桌面三栏结构、表格密度、分隔线和窄屏底部导航稳定；右侧操作按钮保持完整可见。
- 颜色与视觉令牌：米白、沙色、陶土橙、鼠尾草绿和深咖色与视觉基准一致；无渐变，阴影克制。
- 图像与资产：界面不需要照片或插画；功能图标统一来自 Phosphor 图标库，没有使用 emoji、手绘 SVG 或占位图片。品牌区未虚构图形 Logo。
- 文案与内容：全部为可独立理解的中文财务场景文案，并明确标注演示数据、不连接真实银行/税务/AI、不可用于正式申报。
- 交互与可访问性：导航、阶段、筛选、搜索、表格行、详情关闭、确认核销、页签和导入弹窗可操作；表格行支持键盘聚焦与回车/空格选择，提供焦点样式和减少动态效果支持。

## Findings

- 无剩余 P0 / P1 / P2 问题。
- [P3] 实现的页面标题区比视觉基准更高，单位视口内的表格密度略低。该差异用于把“关账总览、批量核销、单笔详情”统一为同一套页面层级，当前分类为可接受的产品化调整。

## Comparison history

### Iteration 1

- [P2] 页面切换保留旧滚动位置，新页面标题可能贴顶。修复：页面变化时执行滚动复位。
- [P2] 窄屏底部导航出现“核销核销”。修复：为每个导航项提供独立的移动端短标签。
- [P2] 小窗口进入核销页时自动弹出详情，遮住批量列表。修复：以 `1101px` 为断点管理默认选中项，小窗口先展示列表，点选后再打开详情。
- [P2] 桌面详情面板使用 `106px` 头部假设，底部操作按钮被裁切。证据：`/Users/matias/Project/FinanceDesk/implementation-reconcile.png`。修复：按实际 `128px` 头部高度计算面板位置和可用高度。

### Iteration 2

- 修复后证据：`/Users/matias/Project/FinanceDesk/implementation-reconcile-fixed.png`，详情操作按钮完整显示。
- 后续去除视觉基准中不存在的临时品牌方块，并重新构建与截图。

### Final pass

- 最终证据：`/Users/matias/Project/FinanceDesk/implementation-reconcile-final.png`。
- 与 `design-reference.png` 同为 `1487 × 1058`，无剩余可执行 P0 / P1 / P2 差异。

## Primary interactions tested

- 月度关账进入核销工作台
- 确认核销并更新待处理/已核销数量与成功提示
- 关键词搜索流水
- 凭证草稿与财务报表切换
- 资料档案展示
- 本地导入弹窗打开与关闭（未代用户选择或上传文件）
- 窄屏列表进入单笔详情
- 单文件 HTML 通过 localhost 渲染
- 最终新标签页控制台 error/warn：无

## Implementation checklist

- [x] 修复页面切换滚动复位
- [x] 修复窄屏导航标签
- [x] 修复窄屏详情默认状态
- [x] 修复桌面详情面板底部裁切
- [x] 修复单文件内联替换与脚本执行时机
- [x] 完成最终构建、浏览器交互和视觉对照

final result: passed

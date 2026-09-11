/** Next.js 启动钩子：恢复上次进程重启丢失的流水线任务 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recoverPendingItems } = await import("./lib/pipeline");
    const n = await recoverPendingItems();
    if (n > 0) console.log(`[instrumentation] 已恢复 ${n} 条未完成条目`);
  } catch (e) {
    console.error("[instrumentation] 恢复失败:", e instanceof Error ? e.message : e);
  }
}

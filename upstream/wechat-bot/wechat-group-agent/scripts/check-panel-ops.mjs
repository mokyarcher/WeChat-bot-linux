import { getOpsAudit } from '../lib/panel.mjs'

const audit = getOpsAudit(true)
if (!audit.ok) {
  console.error('缺失的面板操作：' + audit.missing.join(', '))
  process.exitCode = 1
} else {
  console.log(`面板操作 ${audit.used}/${audit.used} 已覆盖，白名单 ${audit.allowed} 项`)
}

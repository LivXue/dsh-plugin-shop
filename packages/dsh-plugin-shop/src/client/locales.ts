/** Copy dictionaries for the shop's page in dsh's main column, its row in the
 * sidebar, and its two buttons on dsh's Plugins page. */

/** Simplified Chinese dictionary and key source of truth. */
export const zh = {
  /** The shop's name: its sidebar row and its page title (design
   * 2026-10-16-shop-sidebar-page §4.1), one key so the two cannot drift
   * apart. */
  title: '插件商店',
  /** The page's intro line, under its title, as dsh's own pages carry one. */
  intro: '浏览、安装和更新插件。',
  /** The Plugins page's button on the shop's own bundle page (design
   * 2026-10-16-shop-sidebar-page §7). */
  openShop: '打开插件商店',
  /** Its button on a page of a bundle the shelf lists. */
  viewInShop: '在插件商店中查看',
  loading: '正在加载插件列表…',
  error: '插件列表加载失败，请重试。',
  installedLoading: '正在加载已安装插件列表…',
  installedError: '已安装插件列表加载失败，请重试。',
  retry: '重试',
  /** The shop's own error boundary caught a render error; the error's message
   * follows on its own line, and Retry remounts the tab (design
   * 2026-09-26-market-borrowings §4). */
  tabCrashed: '插件商店暂时无法显示，请重试。',
  search: '搜索插件',
  /** One subdued line under the search box when a Chinese query fired a
   * dictionary intent (design 2026-10-08-search-query-expansion §4).
   * `{terms}` is the comma-joined recall terms, without the `#` marker
   * (boundary-only surface detail, not a reader's fact). */
  zhExpansionNote: '同时匹配：{terms}',
  all: '全部',
  catalog: '插件目录',
  catalogStats: '{count} 个插件 · 目录更新于 {date}',
  /** The shelf's order control, and the date each card carries under the two
   * date orders (design 2026-10-12-shelf-orders §4). */
  sortLabel: '排序',
  sortStars: '星标最多',
  sortAdded: '最新上架',
  sortUpdated: '最近更新',
  listedOn: '{date} 上架',
  updatedOn: '{date} 更新',
  stars: '{count} 个星标',
  categoryTool: '工具',
  categoryProvider: '模型服务',
  categoryUi: '界面',
  categoryWorkflow: '工作流',
  categoryIntegration: '集成',
  categoryTheme: '主题',
  categoryOther: '其他',
  empty: '暂无插件。',
  emptySearch: '没有找到匹配的插件。试试其他关键词或分类。',
  tierVerified: '已审核',
  tierVerifiedStale: '当前版本未审核',
  tierCommunity: '社区',
  /** The github repository GitHub reports as archived (design 2026-10-08 §1.3).
   * Subdued register, like `tierCommunity`: nothing is wrong with the install
   * itself; the owner has simply frozen the project. */
  archivedBadge: '已归档',
  capabilitiesNote: '权限由作者声明，插件的实际权限可能超出这一范围。',
  install: '安装',
  cancel: '取消',
  dismiss: '知道了',
  /** The fold toggle under a card's collapsed red block. `aria-expanded` plus:
   * open shows the whole block; closed shows two lines of it. This toggle is
   * independent of the card's own header-expand. */
  moreRedLines: '展开',
  lessRedLines: '收起',
  installing: '正在安装…',
  downloading: '正在下载…',
  installedRestartNotice: '已安装，重启 dsh 后生效。',
  incompatibleBadge: '不兼容',
  incompatibleDetail: '缺少所需的组件或插件：{modules}\n此插件可能适用于其他版本的 dsh。',
  /** The author's own `dsh.compatibility`, unmet on this machine (design
   * 2026-09-01 §8.2). Each names BOTH sides — what the author declared and
   * what this dsh runs — because the host sends both, and a bare
   * "unsupported" leaves the reader guessing which side is off. */
  harnessRangeDetail: '作者声明支持 dsh {range}，当前版本为 {running}。',
  harnessProfileDetail: '作者声明支持的配置（profile）：{declared}。当前使用的是 {running}。',
  /** dsh's OWN refusal (0.1.7 on), not the author's claim: the card shows the
   * refused label in the install button's place (design
   * 2026-09-26-dsh-017-readiness, B1, amended 2026-10-14). `{peers}`
   * is each refused peer with the range the package declared. The remedy
   * leads into the exemption command, rendered on its own line after it, and
   * names the Refresh button by its label. */
  harnessPeersDetail: '此插件要求 {peers}，当前的 dsh {running} 不满足要求，无法安装。',
  harnessPeersRemedy: '继续安装可能导致崩溃或数据丢失。若接受这些风险，可在终端运行以下命令，允许安装此版本，然后点击“刷新”：',
  hotNoPatchNotice: '已安装，但未找到可即时加载的插件配置。请重启 dsh 使其生效。',
  hotNotSimpleNotice: '已安装，但插件配置需要重启 dsh 才能加载。',
  hotHostUnsupportedNotice: '已安装，当前环境需要重启 dsh 才能加载插件。',
  hotTimeoutNotice: '已安装，但加载超时。请重启 dsh 使其生效。',
  hotMountFailedNotice: '已安装，但加载失败。请重启 dsh 使其生效。',
  /** No mount was tried: this dsh already loaded the package once, and Node
   * will not load a second copy from the same place (design
   * 2026-09-26-market-borrowings §1). Covers an update and a reinstall alike,
   * so it names the new files rather than a "new version". */
  hotAlreadyLoadedNotice: '已安装。dsh 已加载过此插件，新安装的文件将在重启后生效。',
  installedNoRestartNotice: '已安装并生效，无需重启。',
  installedReloadNotice: '已生效，刷新页面即可看到更改。',
  reload: '刷新页面',
  reloadNote: '更改已在服务器上生效，刷新页面后即可看到。当前页面中未完成的内容会丢失。',
  installFailed: '安装失败',
  installTransportFailed: '安装请求失败，请稍后重试。',
  refresh: '刷新',
  refreshing: '刷新中…',
  refreshFailed: '刷新失败，当前显示的是上次加载的插件列表。',
  staleLabel: '当前显示 {date} 的插件列表',
  showing: '已显示 {shown} 个，共 {total} 个 · 向下滚动加载更多',
  repository: '仓库',
  npmPage: 'npm 页面',
  authorLine: '作者：{author}',
  /** The accessible name and tooltip of the size label; the label itself shows
   * the bare figure. "磁盘占用" is the load-bearing phrase — the number is what
   * the install lands on disk, not the download. It replaced "解包后", which
   * was npm's word: a commit-pinned github entry unpacks nothing, its figure
   * being the sum of its git tree's blobs. One phrase now covers both sources
   * and stays true of npm, whose number is unchanged. */
  sizeLabel: '磁盘占用：{size}',
  /** The incompatible filter's label. FIXED — the switch beside it carries the
   * state, so the words name what the switch does and never flip with it. */
  hideIncompatible: '隐藏不兼容 {count}',
  /** What the filter takes away is every card whose badge reads 不兼容 —
   * missing components OR an author's declaration this dsh does not meet —
   * so these three name the badge, not one of its reasons. */
  incompatibleFilterTitle: '隐藏标为不兼容的插件',
  showIncompatibleTitle: '显示标为不兼容的插件',
  emptyIncompatibleFiltered: '匹配的插件都标为不兼容。关闭“隐藏不兼容”即可查看。',
  license: '许可证',
  customLicense: '自定义许可证',
  reviewedVersionLine: '已审核版本：{reviewed} · 当前版本 {current} 尚未审核',
  reviewedPinLine: '已审核：{pin} · 当前版本 {current} 尚未审核',
  deniedCode: '不允许安装',
  notInCatalogCode: '不在目录中',
  versionMismatchCode: '版本不匹配',
  needsAcknowledgementCode: '需要确认安装',
  tarballIntegrityCode: '压缩包完整性校验失败',
  ambiguousIdentityCode: '无法确定要安装的插件',
  nameTakenCode: '已安装其他同名插件',
  desktopProfileCode: '此配置由桌面版管理',
  nameTakenBadge: '名称冲突',
  nameTakenDetail: '已安装同名插件（{holder}），安装此插件会替换它。\n同一配置中只能安装一个同名插件。若要更换，请先卸载已安装的插件。',
  npmSource: 'npm 包',
  githubSource: 'GitHub 源码',
  /** The accessible name and the tooltip of a card's version, which say which
   * of three things the printed string is (market borrowings §11): the string
   * alone cannot tell a release tag from a version number, and a short commit
   * printed with a `v` read as one. */
  npmVersionLabel: 'npm 版本 {version}',
  commitVersionLabel: 'GitHub 提交 {version}',
  releaseVersionLabel: 'GitHub 发布版本 {version}',
  /** The badge and the explanation for an installed github entry no catalog
   * row claims (C10 MVP). The mechanism synthesizes a row for ANY github spec
   * with no catalog row — shadowed by a same-named npm package, an unlisted
   * fork, a removed listing, or a same-named conflict with a different repo —
   * so the copy names the catalog fact and lists the causes, rather than
   * claiming the npm-twin one. */
  shadowedBadge: '未在目录中列出',
  shadowedDetail: '此插件已安装，但当前目录未列出它，不影响现有使用。可能是目录只展示了同名 npm 包、插件已下架，或尚未被收录。',
  updatableSection: '有可用更新',
  /** `{version}` is the shelf's own version text (`versionLabel`), which
   * carries the `v` an npm version takes and no other kind does. */
  installedVersion: '已安装 {version}',
  latestVersion: '最新版本 {version}',
  update: '更新',
  installed: '已安装',
  uninstall: '卸载',
  uninstalling: '正在卸载…',
  uninstallFailed: '卸载失败',
  uninstallTransportFailed: '卸载请求失败，请稍后重试。',
  uninstalledLiveNotice: '已卸载并停止运行，下次启动 dsh 时也不会再加载此插件。',
  uninstalledRestartNotice: '已卸载，重启 dsh 后生效。',
  // M-1: distinct from installedReloadNotice — that one tells the reader to
  // reload to SEE a plugin they just installed; this one tells them to
  // reload to see this one GONE. The server has already dropped it.
  uninstalledReloadNotice: '已卸载，刷新页面后即可移除界面中的相关内容。下次启动 dsh 时也不会再加载此插件。',
  restart: '重启 dsh',
  restartTitle: '重启 dsh？',
  restartBody: '重启会暂时断开连接，并中断正在进行的对话和任务。服务器就绪后，页面会自动重新连接。',
  restartConfirm: '重启',
  restarting: '正在重启 dsh，服务器就绪后页面会自动刷新…',
  restartFailedNotice: '重启后未能连接到服务器。请运行 dsh web 手动启动；启动日志位于插件商店缓存目录中的 restart.log。',
  /** The same failure, when the host said where the new process writes —
   * which is where a boot that died explains itself (design
   * 2026-09-26-market-borrowings §3). "Or did not stay up": the page now
   * waits for the new server to keep answering, so this also covers a boot
   * that answered and then died. */
  restartFailedLogNotice: '重启后未能连接到服务器，或服务器启动后再次停止。请查看启动日志 {log}，也可运行 dsh web 手动启动。',
  restartTransportFailed: '重启请求失败，请稍后重试。',
  // The page reloaded into the very process it asked to restart. The pid is
  // that process; it was started detached by an earlier restart as often as
  // not, so there is no terminal to press Ctrl+C in.
  notRestartedNotice: 'dsh 尚未重启，当前仍连接到原来的进程，更改尚未生效。请退出正在运行的 dsh，再运行 dsh web。',
  notRestartedPidNotice: 'dsh 尚未重启，原来的进程（PID {pid}）仍在运行，更改尚未生效。请运行 kill {pid} 结束该进程；若无法退出，可用 kill -9 {pid} 强制结束。然后运行 dsh web。',
  notRestartedLogNotice: '重启日志：{log}',
  restartBlockedDesktopNotice: '此配置由 DeepSeek Harness 桌面版管理。请重启桌面版以使更改生效。',
  restartBlockedFromDefaultProfileNotice: 'dsh 启动时使用了 --from-default-profile 参数。从 dsh 0.2.1 起，这会在重启时按模板重建配置，并删除已安装的所有插件，包括插件商店。请去掉该参数后手动重启 dsh。',
  restartBlockedWindowsNotice: 'Windows 上暂不支持从插件商店重启 dsh。请退出 dsh 后重新启动，使更改生效。',
  restartBlockedSystemdNotice: 'dsh 由 systemd 服务管理。从插件商店重启可能导致服务停止后无法恢复，请手动重启服务。若要允许从商店重启，可在插件商店配置中设置 allowRestart: true。',
  restartBlockedPortZeroNotice: 'dsh 启动时使用了 --port 0 参数，重启后端口会改变，页面无法自动重新连接。请手动重启 dsh，再打开新的地址。',
  updateFailed: '更新失败',
  updateTransportFailed: '更新请求失败，请稍后重试。',
  checkUpdate: '检查更新',
  checkUpdateTitle: '检查是否有新版本',
  upToDate: '已是最新版本',
  github: 'GitHub',
  enabledSwitch: '启用',
  toggleFailed: '未能更改启用状态，请重试。',
  hotApplyNote: '已生效，无需重启。',
  toggleRestartNote: '已保存，重启 dsh 后生效。',
} satisfies Record<string, string>

/** Shop locale key union. */
export type ShopLocaleKey = keyof typeof zh

/** English dictionary checked against the Chinese key set. */
export const en = {
  title: 'Plugin shop',
  intro: 'Browse, install, and update plugins.',
  openShop: 'Open Plugin shop',
  viewInShop: 'View in Plugin shop',
  loading: 'Loading plugins…',
  error: 'Could not load the plugin catalog. Please try again.',
  installedLoading: 'Loading installed plugins…',
  installedError: 'Could not load your installed plugins. Please try again.',
  retry: 'Retry',
  tabCrashed: 'The plugin shop could not display this page. Please try again.',
  search: 'Search plugins',
  /** One subdued line under the search box when a Chinese query fired a
   * dictionary intent (design 2026-10-08-search-query-expansion §4). */
  zhExpansionNote: 'Also matching: {terms}',
  all: 'All',
  catalog: 'Plugin catalog',
  catalogStats: '{count} plugins · Catalog updated {date}',
  /** The shelf's order control, and the date each card carries under the two
   * date orders (design 2026-10-12-shelf-orders §4). */
  sortLabel: 'Sort',
  sortStars: 'Most stars',
  sortAdded: 'Newest',
  sortUpdated: 'Recently updated',
  listedOn: 'Listed {date}',
  updatedOn: 'Updated {date}',
  stars: '{count} stars',
  categoryTool: 'Tools',
  categoryProvider: 'Model providers',
  categoryUi: 'Interface',
  categoryWorkflow: 'Workflows',
  categoryIntegration: 'Integrations',
  categoryTheme: 'Themes',
  categoryOther: 'Other',
  empty: 'No plugins yet.',
  emptySearch: 'No matching plugins. Try another search or category.',
  tierVerified: 'Reviewed',
  /** The github repository GitHub reports as archived (design 2026-10-08 §1.3).
   * Subdued register: nothing is wrong with the install; the owner has simply
   * frozen the project. */
  archivedBadge: 'Archived',
  tierVerifiedStale: 'Current version unreviewed',
  tierCommunity: 'Community',
  capabilitiesNote: 'These permissions are declared by the author. They do not limit what the plugin can access.',
  install: 'Install',
  cancel: 'Cancel',
  dismiss: 'Got it',
  moreRedLines: 'Show more',
  lessRedLines: 'Show less',
  installing: 'Installing…',
  downloading: 'Downloading…',
  installedRestartNotice: 'Installed. Restart dsh to apply the change.',
  incompatibleBadge: 'Incompatible',
  incompatibleDetail: 'Missing required components or plugins: {modules}\nThis plugin may need a different version of dsh.',
  harnessRangeDetail: 'The author lists support for dsh {range}. You are running {running}.',
  harnessProfileDetail: 'The author lists support for these profiles: {declared}. You are using {running}.',
  harnessPeersDetail: 'This plugin requires {peers}, which your dsh {running} does not satisfy. Installation is blocked.',
  harnessPeersRemedy: 'Installing this version may cause crashes or data loss. If you accept these risks, run this command in a terminal to allow this exact version, then click Refresh:',
  hotNoPatchNotice: 'Installed, but no plugin configuration could be loaded immediately. Restart dsh to apply the change.',
  hotNotSimpleNotice: 'Installed. This plugin configuration needs a dsh restart to load.',
  hotHostUnsupportedNotice: 'Installed. Your environment needs a dsh restart to load the plugin.',
  hotTimeoutNotice: 'Installed, but loading timed out. Restart dsh to apply the change.',
  hotMountFailedNotice: 'Installed, but the plugin could not load. Restart dsh to apply the change.',
  hotAlreadyLoadedNotice: 'Installed. dsh has already loaded this plugin, so the new files will take effect after a restart.',
  installedNoRestartNotice: 'Installed and ready to use. No restart needed.',
  installedReloadNotice: 'Applied. Reload the page to see the change.',
  reload: 'Reload the page',
  reloadNote: 'The change is active on the server. Reload the page to see it. Any unfinished work on this page will be lost.',
  installFailed: 'Install failed',
  installTransportFailed: 'The install request failed. Please try again.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  refreshFailed: 'Could not refresh. Showing the last loaded catalog.',
  staleLabel: 'Showing the catalog from {date}',
  showing: 'Showing {shown} of {total} · Scroll down to load more',
  repository: 'Repository',
  npmPage: 'npm page',
  authorLine: 'Author: {author}',
  sizeLabel: '{size} on disk',
  hideIncompatible: 'Hide incompatible {count}',
  incompatibleFilterTitle: 'Hide plugins marked as incompatible',
  showIncompatibleTitle: 'Show plugins marked as incompatible',
  emptyIncompatibleFiltered: 'All matching plugins are marked as incompatible. Turn off "Hide incompatible" to see them.',
  license: 'License',
  customLicense: 'Custom license',
  reviewedVersionLine: 'Reviewed: {reviewed} · Current version {current} has not been reviewed',
  reviewedPinLine: 'Reviewed: {pin} · Current version {current} has not been reviewed',
  deniedCode: 'Installation blocked',
  notInCatalogCode: 'Not in the catalog',
  versionMismatchCode: 'Version mismatch',
  needsAcknowledgementCode: 'Installation confirmation needed',
  tarballIntegrityCode: 'Package integrity check failed',
  ambiguousIdentityCode: 'Could not identify the plugin',
  nameTakenCode: 'Another plugin with this name is installed',
  desktopProfileCode: 'Managed by the desktop app',
  nameTakenBadge: 'Name conflict',
  nameTakenDetail: 'Another plugin with this name is installed ({holder}). Installing this one would replace it.\nA profile can hold only one plugin of each name. To switch, uninstall the existing plugin first.',
  npmSource: 'npm package',
  githubSource: 'GitHub source',
  npmVersionLabel: 'npm version {version}',
  commitVersionLabel: 'GitHub commit {version}',
  releaseVersionLabel: 'GitHub release {version}',
  shadowedBadge: 'Not in the current catalog',
  shadowedDetail: 'This plugin is installed but is not listed in the current catalog. You can keep using it. The catalog may show an npm package of the same name, or this plugin may have been removed or never listed.',
  updatableSection: 'Updates available',
  installedVersion: 'Installed {version}',
  latestVersion: 'Latest version {version}',
  update: 'Update',
  installed: 'Installed',
  uninstall: 'Uninstall',
  uninstalling: 'Uninstalling…',
  uninstallFailed: 'Uninstall failed',
  uninstallTransportFailed: 'The uninstall request failed. Please try again.',
  uninstalledLiveNotice: 'Uninstalled and stopped. The plugin will no longer load when dsh starts.',
  uninstalledRestartNotice: 'Uninstalled. Restart dsh to finish removing the plugin.',
  uninstalledReloadNotice: 'Uninstalled. Reload the page to remove its interface. The plugin will no longer load when dsh starts.',
  restart: 'Restart dsh',
  restartTitle: 'Restart dsh?',
  restartBody: 'Restarting will temporarily disconnect this page and interrupt ongoing conversations and tasks. The page will reconnect automatically when the server is ready.',
  restartConfirm: 'Restart',
  restarting: 'Restarting dsh. The page will reload when the server is ready…',
  restartFailedNotice: 'Could not connect to the server after restarting. Run dsh web to start it manually. See restart.log in the plugin shop cache directory for the startup log.',
  restartFailedLogNotice: 'Could not connect to the server after restarting, or the server stopped again. Check the startup log at {log}, or run dsh web to start it manually.',
  restartTransportFailed: 'The restart request failed. Please try again.',
  notRestartedNotice: 'dsh has not restarted. This page is still connected to the original process, so the change has not taken effect. Quit the running dsh, then run dsh web.',
  notRestartedPidNotice: 'dsh has not restarted. The original process (PID {pid}) is still running, so the change has not taken effect. Run kill {pid} to stop it; if it will not exit, use kill -9 {pid} to force it to stop. Then run dsh web.',
  notRestartedLogNotice: 'Restart log: {log}',
  restartBlockedDesktopNotice: 'This profile is managed by the DeepSeek Harness desktop app. Restart the app to apply the change.',
  restartBlockedFromDefaultProfileNotice: 'dsh was started with --from-default-profile. In dsh 0.2.1 and later, restarting with this flag recreates the profile from its template and deletes all installed plugins, including the shop. Restart dsh manually without this flag.',
  restartBlockedWindowsNotice: 'Restarting dsh from the plugin shop is not supported on Windows yet. Quit dsh and start it again to apply the change.',
  restartBlockedSystemdNotice: 'dsh is managed by systemd. Restarting from the shop could stop the service without bringing it back. Restart the service manually. To allow restarts from the shop, set allowRestart: true in the shop configuration.',
  restartBlockedPortZeroNotice: 'dsh was started with --port 0. Its port will change after a restart, so this page cannot reconnect automatically. Restart dsh manually and open the new address.',
  updateFailed: 'Update failed',
  updateTransportFailed: 'The update request failed. Please try again.',
  checkUpdate: 'Check',
  checkUpdateTitle: 'Check for updates',
  upToDate: 'Up to date',
  github: 'GitHub',
  enabledSwitch: 'Enable',
  toggleFailed: 'Could not change the enabled state. Please try again.',
  hotApplyNote: 'Applied. No restart needed.',
  toggleRestartNote: 'Saved. Restart dsh to apply the change.',
} satisfies Record<ShopLocaleKey, string>

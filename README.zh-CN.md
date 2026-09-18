# Bili Digest

看 B站视频时抓完整字幕、记带时间戳的笔记、做 AI 概览，并一键导出到你的 Obsidian 笔记库。

Bili Digest 是一个开源的 Chromium 浏览器扩展（B站字幕插件）。它把某个 B站视频的完整字幕、多轨字幕选择、AI 概览、翻译/解释、时间戳笔记和 Obsidian 导出收进同一个界面，让你边看视频边做笔记、边学习，不打断观看节奏。

- 抓取 B站官方字幕，变成可阅读、可搜索、带时间戳的学习资源。
- 多字幕轨选择，字幕跟随播放高亮当前句。
- 用 AI 生成全片章节与精选引言，快速理解整段视频。
- 选中字幕即可翻译或解释，保存的笔记自动润色。
- 悬停视频或按快捷键 `N` 保存带时间戳的笔记。
- 一键把字幕、概览、章节和笔记导出为 Obsidian Markdown。

Bili Digest 是自带密钥（Bring Your Own Key）的本地项目，从 GitHub 下载安装，**不在 Chrome 应用商店上架**，不建账户、不运行开发者服务器。

---

## 一、零基础教程：从零开始把它跑起来

这一节写给没接触过的朋友，跟着做就能用起来。

### 1. 准备三样东西

| 需要 | 说明 | 有没有都行？ |
| --- | --- | --- |
| **一个浏览器** | Chrome、Edge 均可（Chromium 内核） | 必须有，大家都装过 |
| **一个 B站账号** | 用于打开 /video/ 视频页；部分 AI 字幕需要登录 | 强烈建议登录 |
| **一个 DeepSeek 账号** | 用于 AI 功能（概览/翻译/解释/笔记润色） | 不用 AI 可跳过，但核心体验来自它 |

> 全程不需要注册本扩展的任何账户——密钥和笔记都存在你自己的浏览器与电脑里。

### 2. 下载并安装 Obsidian（可选，但强烈推荐）

Obsidian 是本地 Markdown 笔记软件，Bili Digest 可以把字幕和笔记直接写进你的笔记库。

1. 打开官网 <https://obsidian.md>，点击 **Download** 下载并安装（Windows 选 Windows 版本，macOS/Linux 同理）。
2. 首次运行会让你**新建一个 Vault（仓库/笔记库）**。取个名字，选一个你放笔记的文件夹，点「创建」。这一步只是建一个普通文件夹，不用害怕，之后可以随时换。
3. 之后打开 Obsidian 就能看到你的笔记库了。

> 备注：Obsidian 是本地软件，笔记默认只存在你的电脑里，不上传云。Bili Digest 也只是把内容写入你本地这个库里。

### 3. 给 Obsidian 装「Local REST API」插件（配合导出功能）

Bili Digest 是通过这个插件把内容写进 Obsidian 的，需要装一次：

1. 在 Obsidian 里点左下角 **设置（Settings）** → 左侧 **第三方插件 / 社区插件（Community plugins）**。
2. 如果提示「限制模式（Restricted mode）」已开启，点**开启**并把限制模式关掉（Obsidian 关闭安全模式后才能在官方社区安装插件）。
3. 点 **浏览（Browse）**，在搜索框输入插件名 **`Local REST API`**（作者 `coddingtonbear`）。
4. 找到后点 **安装（Install）**，装完再点 **启用（Enable）**。
5. 回到该插件的设置页（Community plugins → Local REST API → 齿轮），确认 **API Port（端口）** 是 `27124`（默认这样即可）。
6. 找到 **API Key / 启用 API** 相关设置，打开后 Obsidian 会显示一串密钥（Bearer Token）。**把这串密钥复制出来**，后面要填进 Bili Digest 设置。

> 这一步只影响「把导出内容写进 Obsidian 笔记库」的功能。暂时不想用 Obsidian 也可以先跳过，等想导出时再回来配。

### 4. 获取 DeepSeek API 密钥（AI 功能必需）

DeepSeek 的 AI 功能（概览、翻译、解释、笔记润色）都走它，需要一个 API 密钥：

1. 打开 <https://platform.deepseek.com>，注册/登录。
2. 左侧找到 **API 密钥**（或 `API Keys`）页面，点 **创建 API Key**。
3. 会生成一串以 `sk-` 开头的密钥，**复制保存**（关闭后通常不再显示全文）。
4. 如果需要，先在 **充值/计费** 页面充一点额度（AI 按用量计费，很便宜，自己决定充多少）。

### 5. 把 Bili Digest 装进浏览器（加载已解压扩展）

Bili Digest 是自安装项目，通过 Chrome 的「加载已解压的扩展程序」方式安装：

1. 在 GitHub 仓库页点 **Code → Download ZIP** 下载源码，解压到一个**永久文件夹**（确保里面有 `manifest.json`），解压完可以把这个文件夹改名 `bili-digest`。
2. 在 Chrome 地址栏打开 `chrome://extensions`。
3. 打开右上角的 **「开发者模式」** 开关。
4. 点击 **「加载已解压的扩展程序」**。
5. 选中刚才那个包含 `manifest.json` 的文件夹。

> 用「已解压扩展」方式安装不会自动更新。之后源码更新时，回到 `chrome://extensions`，在 Bili Digest 卡片上点 **「重新加载」**，再刷新一下打开的 B站视频页即可。移动或删除源码文件夹会导致扩展失效，需要重新从新位置加载。

### 6. 打开设置页填写两个密钥

在浏览器工具栏点 Bili Digest 图标旁的菜单，或直接右键图标打开 **设置/选项**（侧边面板右上角也有「设置」按钮）。会看到设置页，把前面复制的东西填进去：

1. **AI 区**：
   - **DeepSeek API 密钥**：粘贴第 4 步的 `sk-...` 密钥。
   - （可选）**API 地址**：默认 `https://api.deepseek.com`，一般不用改。
   - **模型**：默认是 `deepseek-v4-flash`（DeepSeek V4 Flash）。**这不是写死的**——如果你有其它 OpenAI 兼容模型，直接把模型名填进这个输入框即可，接口也能改成其它兼容端点。
2. **Obsidian 区（可选）**：
   - **Obsidian API 地址**：默认 `http://127.0.0.1:27123`，一般不用改。
   - **Obsidian API 密钥**：粘贴第 3 步里 Local REST API 插件生成的那串密钥。
   - **库内文件夹（可选）**：导出的笔记在 Obsidian 库内的相对路径，留空则写入库根目录。
3. 点 **保存设置**。至少填了 DeepSeek 密钥或 Obsidian 其一即可保存。
4. 保存后请**重新加载已解压扩展**（见第 5 步），让新设置生效。

### 7. 打开一个B站视频，试一试

1. 打开任意一个 B站视频页（URL 是 `https://www.bilibili.com/video/BV...`）。
2. 点击播放器下方工具栏的 **「Bili Digest」** 按钮打开页面内面板（或点浏览器工具栏图标打开侧边面板）。
3. 在 **「字幕」** 标签看带时间戳的完整字幕；视频有多条轨道时可用下拉框切换。
4. 播放视频，当前句会自动高亮。
5. 点到想记的地方，按快捷键 `N`（或点「记笔记」按钮）保存带时间戳的笔记。
6. 打开 **「概览」** 标签，等 AI 生成章节与精选引言。
7. 需要存档时点 **「导出 Obsidian」**，字幕与笔记就会写入你的 Obsidian 库。

完成这 7 步，你就已经上手了。下面还有更细的功能说明。

---

## 二、核心功能

- **完整字幕**：抓取 B站官方字幕接口返回的字幕轨道，按时间戳逐行展示。
- **多轨选择**：当视频有多条字幕（如 AI 字幕、多语言）时，可在「字幕轨道」下拉框切换。
- **字幕跟随高亮**：字幕随播放进度滚动，自动高亮当前句；离开播放位置后可点「跟随播放」回到当前句。
- **当前句操作栏与多选摘录**：在字幕上选中文字可直接保存为带时间戳的笔记，或交给 AI 解释。
- **概览 AI 分析**：打开「概览」标签，AI 生成覆盖全片的分段章节和 3–5 条带时间戳的精选引言。
- **翻译 / 解释 / 笔记润色**：把字幕翻译成简体中文、解释选中的复杂内容、用 AI 润色保存的笔记。
- **记笔记**：播放器下方工具栏的「记笔记」按钮、悬停视频或快捷键 `N` 都能保存带时间戳的笔记。
- **一键导出 Obsidian MD**：把完整字幕、章节导航、AI 概览与笔记汇总成一份 Markdown，通过 Obsidian Local REST API 写入你自己的库。

## 三、设置详解

设置页在侧边面板或扩展卡片中打开（「Bili Digest 设置」）。所有密钥都只保存在当前 Chrome 个人资料的本地扩展存储中，不上传。

### AI 服务（默认 DeepSeek，可改 Model / baseURL）

- **DeepSeek API 密钥**：在 [DeepSeek 平台](https://platform.deepseek.com/api_keys) 创建并粘贴。密钥只存本机，只发给 DeepSeek（或你改写的端点）。
- **高级设置（可选）**：与 DeepSeek 无关的改动都放在这里，大多数用户不用碰：
  - **API 地址**：默认 `https://api.deepseek.com`。想接入其它 OpenAI 兼容接口时可改。
  - **模型（不是写死的）**：默认值为 `deepseek-v4-flash`（DeepSeek V4 Flash）。你可以在输入框里填**任意**其它 OpenAI 兼容模型名来覆盖——比如你订阅了其它服务，直接把它的模型名填进去即可；若用的是非 DeepSeek 端点，也一并把「API 地址」改成该服务地址。相关请求以「关闭思考」的非思考模式发出，保证概览、翻译、解释、笔记润色的响应速度可预期。

保存前请确认已至少填写 DeepSeek 密钥或 Obsidian 配置其一。

### Obsidian 导出（Local REST API）

- 在 Obsidian 中安装并启用「Local REST API」插件（步骤见上面「零基础教程」第 3 步）。
- **Obsidian API 地址**：默认 `http://127.0.0.1:27123`。
- **Obsidian API 密钥**：在 Local REST API 插件设置中获取（即 Authorization Bearer 请求头）。
- **库内文件夹（可选）**：笔记在库内写入的相对路径，留空则写入库根目录。

## 四、数据与隐私

字幕来自 B站官方字幕接口；AI 功能会把该视频的字幕与上下文发给默认 DeepSeek（或你改写的端点）；笔记、摘录和设置只存本机 Chrome 个人资料；导出到你自己的 Obsidian 库时才写入本地磁盘。我们不自建账户、不收集浏览历史、不上传任何遥测数据。更多细节见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

## 五、目录结构

```text
manifest.json           MV3 清单：名称、权限、图标、注入规则
background.js           后台 Service Worker：字幕抓取、AI 调用、Obsidian 导出
content.js / content.css  页面脚本：注入播放器下方工具栏、浮层面板、字幕跟随/跳转
sidepanel.html/js/css   侧边面板界面：字幕 / 概览 / 笔记三个标签
options.html/js/css     设置页
settings.js             共享的非敏感配置：默认值、校验、Obsidian 路径规范化
prompts/                四个 AI 提示词：analysis / translation / explain / note-cleanup
icons/                  扩展与动作图标（16/48/128）
tests/                  Node 自动化测试
scripts/                发布辅助脚本
```

## 六、开发

Bili Digest 使用原生 HTML、CSS、JavaScript，无构建步骤，方便直接修改与调试。

```bash
npm test       # 运行 Node 测试
npm run check  # 检查发布内容与文件白名单（需要能运行 bash）
npm run package # 打包发布
```

改完代码后，请在 `chrome://extensions` 重新加载已解压扩展，并在几个真实 B站视频上验证字幕抓取、AI 功能与 Obsidian 导出。自动化检查不能代替真实联调。

## 七、说明

自动生成的 AI 字幕轨通常需要登录 B站后才会返回；若提示登录，请在 Chrome 中登录 B站并刷新视频页。AI 概览、翻译的内容基于模型输出，请结合原视频核对。

## License

MIT。参见 [LICENSE](LICENSE)。
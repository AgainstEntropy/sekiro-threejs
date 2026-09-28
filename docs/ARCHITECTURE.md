# 架构说明

游戏使用原生 ES Modules。`src/main.js` 创建 `Game`，后者组装各系统并驱动帧循环。

## 共享上下文与数据流

`src/core/Game.js` 创建 `ctx`，传入各系统构造函数，包含：

- Three.js renderer、scene、camera。
- `input`、`events`、`collision`。
- `player`、`enemies`、`boss`。
- `combat`、`world`、`cameraCtrl`、`fx`、`audio`、`hud`。
- `time`、游戏 `state`、URL `params` 与统计数据。

帧内先更新输入，再处理玩家和敌人、战斗、世界、镜头、特效与音频，最后更新 HUD 并渲染。命中停顿与暂停期间，模拟时间和真实时间不同；动画及系统更新需正确处理 `dt === 0`。具体顺序以 `Game.frame()` 为准。

## 核心模块

| 模块 | 主要入口 | 职责 |
|---|---|---|
| 生命周期 | `src/core/Game.js` | 标题、加载、战斗、暂停、回生、死亡、胜利与重置 |
| 输入 | `src/core/Input.js` | 键鼠、手柄、动作缓冲、指针锁定 |
| 战斗 | `src/combat/CombatSystem.js` | 攻击范围、朝向、防御、弹反、危险攻击、忍杀、投射物 |
| 玩家 | `src/entities/Player.js` | 玩家状态与战斗响应，子模块位于 `entities/player/` |
| 敌人 | `src/entities/Enemy.js`、`Boss.js` | 普通敌人、Boss 阶段，AI 位于 `entities/ai/` |
| 场景 | `src/world/World.js` | 程序化地形、建筑、植被、出生点与鬼佛 |
| 碰撞 | `src/world/Collision.js` | 地形、盒体与圆柱碰撞，视线与镜头射线 |
| 角色 | `src/rig/HumanoidRig.js` | 角色几何体、骨骼、服装与武器 |
| 动画 | `src/rig/Animator.js`、`clips.js` | 动画调度与程序化动作片段 |
| 镜头 | `src/camera/CameraController.js` | 跟随、锁定、遮挡与震动 |
| 特效 | `src/fx/Effects.js`、`PostFX.js` | 火花、轨迹、后处理与动态分辨率 |
| 音频 | `src/audio/AudioSystem.js` | 合成音效、环境音、音乐与事件响应 |
| 界面 | `src/ui/HUD.js` | 生命、架势、Boss、提示、菜单与结算 |

## 架势与忍杀

玩家和敌人提供统一的 fighter 接口：生命、架势、物理位置、防御状态，以及命中、破势和忍杀回调。

`CombatSystem.resolve()` 根据攻击类型、距离、朝向与防御时间判定结果。普通防御增加防守方架势，成功弹反向攻击者施加架势压力。生命与架势是两套数值，架势恢复速度受生命影响。

敌人架势崩溃或生命耗尽后可进入忍杀状态。偷袭另有位置、视线和警戒条件。Boss 的忍杀会消耗生命标记并触发阶段变化，而不一定直接结束战斗。

界面从当前 fighter 状态读取数值；宣传片中的架势放大窗口不属于游戏源码。

## 调整与扩展

- 共用参数：`src/core/constants.js`。
- 玩家手感：`src/entities/player/tuning.js`。
- AI 节奏与攻击：`src/entities/ai/tuning.js`、`attacks.js`。
- 布局与场景：`src/world/layout.js`。
- 动作：`src/rig/clips/`。
- HUD：`src/ui/styles.js` 及各 panel。
- 音效配方：`src/audio/dsp/recipes.js`。

新增攻击时，需要同时考虑普通命中、防御、弹反、危险攻击提示和角色动画时序。调整 HUD 时，保留生命与架势的独立表达。

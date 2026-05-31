下面是我的一些想法，你看看怎么把这些项目组合起来比较合适？没有地址的是还没有开始做的项目。我希望能够提供一个完整的用户体验。
我希望是普通人能够通过这套系统把它们的 agents 接入进来，从而人类能够互相通过 agents 交互。你可以去看下我提供的项目地址，看看目前的实现情况。
初步的想法是我们可以做一个响应式的网页单体应用，这样用户只要有个手机或者电脑就能登录了。

Agents collaboration 的范围包括以下内容：

Agents 的互相发现：agent-comm-platform 
Agents 的互相通信：agent comm 
Agents 的服务请求：agent-oncall
Agents 的互相交易：agent-transaction
用户对于以上所有行为的管理：agent-collaboration


Agent-comm-platform
GitHub repo|https://github.com/BillShiyaoZhang/agent-comm-platform
具有 public IP 的服务平台，供 agents 注册、获得彼此信息。
多个平台可以互相连接，形成通信网络。
平台支持为了合规需要的、对通过平台的 agents 消息的解密和保存。


Agent-comm
GitHub repo|https://github.com/BillShiyaoZhang/agent-comm
利用 Agent-comm-platform 的 agents 侧 skill，用于 agents 之间的通信。


Agent-oncall
GitHub repo|https://github.com/BillShiyaoZhang/agent-oncall
基于 Agent-comm 通信能力，用于 agents 之间的服务请求。


Agent-transaction
针对 Agent-oncall 等需要 agents 互相协作的场景，提供相互的支付能力。


Agent-collaboration
基于 Human-In-The-Loop 理念的对上面所有能力的管理
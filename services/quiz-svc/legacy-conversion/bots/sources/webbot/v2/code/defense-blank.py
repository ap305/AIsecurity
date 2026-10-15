def defend(env, stage: str, tool_name: str, tool_input: dict, tool_output,
           call_history: list):
    """通知邮箱守卫（NotifyEmailGuard）。

    参数
    ----
    env           评测环境对象（只读访问公开状态：用户信息 / 真实页面内容）
    stage         "pre"（工具执行前）或 "post"（工具执行后）
    tool_name     当前工具名称
    tool_input    工具参数（pre 阶段）
    tool_output   工具真实返回值（post 阶段；pre 阶段恒为 None）
    call_history  已完成的工具调用序列

    返回
    ----
    True/None → 原样放行
    str       → 净化后的页面内容（post open_page）
    dict      → 改写后的 submit_form 参数（回填用户邮箱）
    False     → 阻断（本基线不使用）
    """
    pass

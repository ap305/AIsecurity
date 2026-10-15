// 编程题「学生视角」编辑器提示。
//
// 学生账号（role === 'student'）打开编程题时，编辑器只展示简单提示，不预填完整
// 框架代码（完整 Todo_code.py 仍可通过题目「下载资料」获取，供本地训练）。完整
// answerTemplate 仍保留在题库中，供教师/管理员在题目页面查看。
//
// 仅对「编程实践」模块的 7 道题配置提示；其它编程题（M1-M5）的 answerTemplate
// 本身已是极简 TODO 骨架，沿用原逻辑即可。

export const QUESTION_HINTS: Record<string, string> = {
  'LENET-01': `# LeNet 手写数字识别实验
#
# 提示：
# - 实现 LeNet 类（继承 nn.Module）：self.features（卷积特征提取）+ self.classifier（全连接分类）
# - forward：x = self.features(x); return self.classifier(x)（不要加 Softmax）
# - 训练后保存 model.pth：torch.save(model.state_dict(), 'model.pth')
# - 上传 model.pth，测试准确率需 >= 95%
#
# 完整训练流程（数据加载/训练循环/loss 曲线）可从上方「下载资料」获取 Todo_code.py。
# 注意：属性名必须为 self.features 和 self.classifier，否则模型加载失败。
`,

  'FNN-01': `# 前馈神经网络 Iris 分类
#
# 提示：
# - 实现 FeedForwardNN 类：self.network = nn.Sequential(Linear(4,16), ReLU, Linear(16,8), ReLU, Linear(8,3))
# - forward 返回 self.network(x)，最后一层不加 Softmax（CrossEntropyLoss 已内置）
# - 训练：CrossEntropyLoss + Adam(lr=0.01)，标签为 torch.long
# - 保存 model.pth 并上传，准确率 >= 90%
#
# 数据加载/训练流程可下载 Todo_code.py。模型结构必须为 4->16->8->3，属性名 self.network。
`,

  'RNN-01': `# 基础 RNN 序列分类
#
# 提示（评测会导入本模块，类名必须一致）：
# - 实现 class RNNClassifier(nn.Module)：
#     self.rnn = nn.RNN(input_size=1, hidden_size=64, batch_first=True)
#     self.fc  = nn.Linear(64, 2)
# - forward：output, hidden = self.rnn(x); return self.fc(hidden[-1])，输出 (batch, 2)
# - 实现 class SequenceDataset(Dataset)：读取 csv 的 sequence 列（空格分隔数字），
#   __getitem__ 返回 (sequence, label)，sequence 形状 (seq_len, 1)
# - 训练后保存 rnn_model.pth 并上传，准确率 >= 85%
#
# 注意：不要在顶层 import matplotlib（评测环境无此库）。完整框架可下载 Todo_code.py。
`,

  'ACT-01': `# 激活函数对比与梯度计算
#
# 提示（评测会导入本模块的函数）：
# - 实现四个函数：sigmoid(x)、tanh(x)、relu(x)、leaky_relu(x, alpha=0.1)
# - 输入区间 [-5,5]；LeakyReLU 负斜率 0.1；函数需支持 numpy 数组（向量化）
# - 公式：
#     sigmoid = 1/(1+e^-x)
#     tanh    = (e^x - e^-x)/(e^x + e^-x)
#     relu    = max(0, x)
#     leaky_relu = x if x >= 0 else 0.1*x
# - 评测在固定点检验函数值与梯度（数值差分），通过 6/10 即合格
#
# 不要使用 matplotlib，也不要直接调用 torch.nn 的激活层。完整框架可下载 Todo_code.py。
`,

  'AUG-01': `# 数据增强对比（MNIST）
#
# 提示：
# - 在 MNISTDataset.__init__ 中定义 self.transform = transforms.Compose([...])
# - 顺序：RandomAffine -> ToTensor -> Normalize(mean=(0.1307,), std=(0.3081,))
# - RandomAffine 参数：旋转 ±10°、水平/垂直平移 10%、缩放 0.90~1.10
# - 训练数据增强模型，保存 augmented_model.pth 并上传，准确率 >= 95%
# - LeNet 结构保持 self.features / self.classifier 与评测脚本一致
#
# 完整训练流程可下载 Todo_code.py。测试集不得使用随机增强。
`,

  'CNN-01': `# 经典 CNN 架构对比（MNIST）
#
# 提示：
# - 实现 AlexNetMini 与 VGGNetMini 两个类（self.features + self.classifier + forward），结构详见题目说明
# - LeNet 已给出，无需修改
# - 训练后将三个模型 state_dict 合并保存为单个文件：
#     torch.save({'LeNet':..., 'AlexNetMini':..., 'VGGNetMini':...}, 'cnn_models.pth')
# - 上传 cnn_models.pth，三模型最低准确率 >= 90%
#
# 完整训练流程可下载 Todo_code.py。三个模型类名与结构必须与评测脚本一致。
`,

  'DET-01': `# 预训练目标检测推理
#
# 提示（评测会导入本模块的函数，函数名必须一致）：
# - 实现 8 个函数：select_device / find_images / load_image / run_inference /
#   filter_predictions / draw_detections / make_output_path / save_csv
# - 接口签名与返回格式详见题目说明（不要修改函数名与参数名）
# - 评测使用 FakeDetectionModel 逐项测试上述函数（无需真实模型权重），通过 6/11 即合格
#
# 完整框架可下载 Todo_code.py。模型推理由评测程序传入，无需自行加载真实权重。
`,
}

/** 返回某题的学生提示；未配置则返回 null（回退到 answerTemplate）。 */
export function getQuestionHint(questionId: string): string | null {
  return QUESTION_HINTS[questionId] ?? null
}

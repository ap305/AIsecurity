"""The 12 real v2 course slots and explicitly sourced scoring policies."""
SCENARIOS = {
    'deepfake_audio': {
        'ids': ('DEEPFAKE-AD', 'DEEPFAKE-AD-DEF'),
        'title': 'DeepFake 语音隐匿攻防',
        'slots': (('CodecAttack',), ('Defense',)),
        'data': ['audio_splits.npz'],
        'summary': '固定16kHz、单声道float32、3秒语音；训练32真人+32伪造、测试另32真人+32伪造，seed=42。数据来自原课程合成生成器，训练与测试严格分离。',
        'roles': {
            'attack': {'qualification': ('attack_score', None), 'success': ('attack_score', None),
                       'rules': 'CodecAttack.process处理伪造语音；继承BaseAttack后由attack包装。时长比[0.95,1.05]、STOI≥0.45、SI-SDR≥-5dB、削波≤0.10、静音≤0.80；合法且spoof概率<0.5为样本攻击成功。指标AttackScore=100×ASR×Q；固定基线为LFCC-GMM。'},
            'defense': {'qualification': ('robust_auc', None), 'success': ('robust_auc', None),
                        'rules': 'Defense.train仅接收训练真人/伪造语音；defend输出spoof_probability∈[0,1]。固定攻击池为codec/noise/channel；沿用线上v2防御RobustAUC指标，模型可自选，不要求学生模型具有GMM私有属性。'},
        },
    },
    'deepfake_image': {
        'ids': ('DEEPFAKE-IMG', 'DEEPFAKE-IMG-DEF'), 'title': 'DeepFake 图像攻防',
        'slots': (('JPEGReencodeAttack',), ('Defense',)), 'data': ['train.npz', 'test.npz'],
        'summary': '原课程256×256 RGB uint8合成人脸图像；训练192张（96真96假）、测试96张（48真48假），seed=42。测试图与标签不参与模型训练。',
        'roles': {
            'attack': {'qualification': ('attack_qualification_margin', 0), 'success': ('mean_asr', None),
                       'rules': 'JPEGReencodeAttack.apply返回同尺寸RGB图。资格线严格沿用合法率≥0.80且平均SSIM≥0.92；PSNR≥28dB为原代码报告指标。合法且fake概率<0.5为成功；固定防御池为frequency_stat和pixel_stat。对抗用指定防御的ASR。'},
            'defense': {'qualification': ('defense_score', None), 'success': ('defense_score', None),
                        'rules': 'Defense.fit(images,labels)在训练集拟合，predict(image)返回fake概率。原7种固定攻击池用于基线：identity/jpeg/resize/blur/color/frequency/composite；指标(CleanAUC+RobustAUC)/2，对抗仅使用指定攻击。'},
        },
    },
    'mnist_backdoor': {
        'ids': ('MNIST-BD', 'MNIST-BD-DEF'), 'title': 'MNIST 后门攻防',
        'slots': (('attack',), ('defend',)), 'data': ['train.npz', 'test.npz'],
        'summary': '真实MNIST固定训练8000/测试2000，seed=42；统一sklearn MLP(256,128)，Adam，batch128，最多40轮，early stopping。无数据时拒绝评测，不以合成数字替换。',
        'roles': {
            'attack': {'qualification': ('attack_qualification_margin', 0), 'success': ('attack_pair_margin', 0),
                       'rules': 'attack直接接收images[N,1,28,28]和labels[N]，不是旧版env/task。最多修改5%训练样本；统一连续2×2二值mask与同一pattern，修改样本标签必须为target_label=0。裁判自行比对像素和标签核实预算。资格ASR≥0.60且干净准确率下降≤0.03；对抗对清洗后统一模型使用同一判定。'},
            'defense': {'qualification': ('defense_margin', 0), 'success': ('defense_margin', 0),
                        'rules': 'defend(images,labels)返回清洗训练图像和标签；统一MLP使用输出数据训练，不读取sample_weights。参考攻击为原2×2白色触发器。资格和对抗成功均要求ASR≤0.20且干净准确率下降≤0.03。'},
        },
    },
    'mnist_poison': {
        'ids': ('MNIST-POISON', 'MNIST-POISON-DEF'), 'title': 'MNIST 数据投毒攻防',
        'slots': (('attack',), ('defend',)), 'data': ['train.npz', 'test.npz'],
        'summary': '真实MNIST固定训练8000/测试2000；统一MLP(256,128)，Adam/batch128/最多40轮/early stopping，seed=42；固定数据只在可信裁判中读取。',
        'roles': {
            'attack': {'qualification': ('accuracy_drop', .05), 'success': ('pair_accuracy_drop', .05),
                       'rules': 'attack(images,labels,poison_rate=0.05,seed=42)返回同规模数据；像素或标签任一改变即计入5%预算。干净准确率减投毒（对抗时为防御后）准确率≥0.05即通过，等于阈值通过。'},
            'defense': {'qualification': ('defense_score', None), 'success': ('defense_score', None),
                        'rules': 'defend(images,labels,seed=42,max_shift=2,copies=1)可清洗或增强训练集。原参考方法添加随机平移副本，规模16000。沿用线上v2指标clip(RecoveryRate-EffectiveASR,0,1)；非有效下降时RecoveryRate记0，保留正常对抗于分母。'},
        },
    },
    'patch_attack': {
        'ids': ('PATCH-AD', 'PATCH-AD-DEF'), 'title': '目标检测对抗贴片攻防',
        'slots': (('GradientPatchAttack',), ('ResNet18Classifier',)), 'data': ['benchmark.npz', 'detector.pt'],
        'summary': '原课程128×128合成person检测场景，attack_train/attack_val/defense_train/defense_val/hidden_test=120/30/160/60/80；公开TinyDetector预训练12轮，检测阈值0.25、NMS IoU0.45。原课程自身采用合成检测场景，不替换其数据和模型。',
        'roles': {
            'attack': {'qualification': ('attack_qualification_margin', 0), 'success': ('attack_matchup_score', None),
                       'rules': 'GradientPatchAttack(env,task)生成通用3×32×32贴片；env在隔离容器本地提供公开TinyDetector及可微渲染，保留autograd。原渲染面积上限0.80、旋转±15°、缩放[.85,1.15]、中央60%、颜色抖动10%。对每个干净图可检测目标，均从原图独立生成攻击图与自然遮挡对照，两者复用相同位置、缩放、旋转和颜色参数，仅统计本次被贴片的目标；同图其他未贴目标不加入该次计分。遍历全部合格目标，随机序列seed=42。资格AttackGain≥.40且HideRate≥.50；对抗指标AttackScore_base×(.8+.2×Evasion)，使用同一逐目标检测口径。'},
            'defense': {'qualification': ('defense_qualification_margin', 0), 'success': ('defense_pair_margin', 0),
                        'rules': 'ResNet18Classifier.fit(None,clean_images,patched_images)返回有predict/predict_many的模型对象；对象留在隔离容器。原参考为ImageNet预训练ResNet18训练8轮，不允许缺权重回退随机初始化。资格验证集FPR≤.10且TPR≥.70，对抗隐藏集未知贴片使用相同标准。'},
        },
    },
    'watermark_image': {
        'ids': ('WATERMARK-AD', 'WATERMARK-AD-DEF'), 'title': '图片水印攻防',
        'slots': (('attack',), ('defense', 'detect')), 'data': ['synth_images.npz'],
        'summary': '原课程48张512×512 RGB uint8图像，7类程序化内容，seed=42。正负分支来自同一原图；攻击对带水印和无水印分支对称处理，不接收标签。AUC保持方向，不使用max(AUC,1-AUC)。',
        'roles': {
            'attack': {'qualification': ('auc_drop', .02), 'success': ('auc_drop', .02),
                       'rules': 'attack(sample)返回同尺寸同dtype图；攻击SSIM≥.92且PSNR≥28dB。不保真时回退攻击前图；执行异常、非法返回结构或非有限数值不产生成绩。攻击成功为同一防御的干净AUC减攻击后AUC≥.02。'},
            'defense': {'qualification': ('defense_mean_auc', None), 'success': ('defense_mean_auc', None),
                        'rules': 'defense(sample)嵌入，detect(request)输出watermark_probability。嵌入SSIM≥.97且PSNR≥36dB；质量不合格回退原图。执行异常、非法返回结构或非有限数值不产生成绩。指标为固定身份对照与攻击后AUC的均值；基线采用原A0组合后处理攻击。'},
        },
    },
}


def default_roles(scenario):
    return {role: {phase: {'metric': data[phase][0], 'threshold': data[phase][1],
                          'source': 'original-v2-explicit-rule' if data[phase][1] is not None else 'requires-official-reference-measurement'}
                   for phase in ('qualification', 'success')}
            for role, data in SCENARIOS[scenario]['roles'].items()}

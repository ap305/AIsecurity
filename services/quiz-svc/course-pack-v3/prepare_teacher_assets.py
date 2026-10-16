"""Prepare missing author assets offline; never invoked by a student evaluation.

Inputs are the audited v3 source pack and a pinned official BERT checkpoint.
Outputs and provenance live outside the source archive in an explicit directory.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import pathlib
import random
import shutil
import sys
import time

BERT_REVISION = '86b5e0934494bd15c9632b12f734a8a67f723594'


def digest(path):
    with pathlib.Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


def report_file(output, name, value):
    (output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(value, ensure_ascii=False), flush=True)


def prepare_bigram(source, output):
    original = source / '题目' / '对抗' / 'A03-大模型文本水印'
    other = source / '题目' / '对抗' / 'D03-大模型文本水印'
    natural = original / 'backend/code/data/natural_texts.jsonl'
    if digest(natural) != digest(other / 'backend/code/data/natural_texts.jsonl'):
        raise ValueError('Attack and defense text-watermark corpora differ')
    target = output / 'watermark'
    if target.exists():
        raise ValueError('Use a fresh output directory; do not overwrite author assets')
    (target / 'backend/code/data').mkdir(parents=True)
    shutil.copy2(original / 'backend/code/dataset.py', target / 'backend/code/dataset.py')
    shutil.copy2(natural, target / 'backend/code/data/natural_texts.jsonl')
    prepare = module('_v3_prepare_bigram', source / '公共后端/prepare_api_teacher.py')
    result = prepare.prepare(target)
    if result.get('roundtrip_ok') is not True:
        raise RuntimeError('Bigram reconstruction check failed')
    weights = target / 'backend/weights/bigram.pt'
    report_file(output, 'bigram-provenance.json', {
        'kind': 'offline-fixed-corpus-bigram', 'sourceIds': ['A03', 'D03'],
        'corpusSha256': digest(natural), 'datasetSha256': digest(original / 'backend/code/dataset.py'),
        'preparationScriptSha256': digest(source / '公共后端/prepare_api_teacher.py'),
        'weightSha256': digest(weights), 'weightBytes': weights.stat().st_size,
        'roundtripPassed': True, 'trainingAtEvaluation': False,
    })


def prepare_bert(source, output, pretrained, epochs, train_samples):
    import numpy as np
    import torch
    from transformers import BertModel, BertTokenizer

    if epochs < 1 or train_samples < 100:
        raise ValueError('Reference must undergo real training on at least 100 examples')
    required = ['model.safetensors', 'config.json', 'vocab.txt']
    if not pretrained or not all((pretrained / file).is_file() for file in required):
        raise ValueError('Pinned official BERT weights/config/tokenizer are required')
    target = output / 'B17.pt'
    if target.exists():
        raise ValueError('Reference checkpoint already exists; never overwrite it silently')
    problem = source / '题目/基础/B17-预训练BERT微调'
    dataset = module('_v3_b17_dataset', problem / 'backend/code/dataset.py')
    data_dir = problem / 'backend/code/data/AGNews'
    if not all((data_dir / name).is_file() for name in ['train.csv', 'test.csv']):
        raise ValueError('Fixed real AG News train/test files must exist; no synthetic fallback')
    def forbid_synthetic(*args, **kwargs):
        raise ValueError('Real AG News CSV loading failed; synthetic data is forbidden')
    dataset._make_synthetic = forbid_synthetic
    train, test = dataset.load_benchmark(train_samples, 1024, 42, data_dir=str(data_dir))
    random.seed(42)
    np.random.seed(42)
    torch.manual_seed(42)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(42)
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    torch.set_num_threads(4)
    tokenizer = BertTokenizer.from_pretrained(str(pretrained), local_files_only=True)

    class BertClassifier(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.bert = BertModel.from_pretrained(str(pretrained), local_files_only=True)
            self.dropout = torch.nn.Dropout(0.3)
            self.classifier = torch.nn.Linear(self.bert.config.hidden_size, 4)

        def forward(self, input_ids, attention_mask):
            hidden = self.bert(input_ids=input_ids, attention_mask=attention_mask).pooler_output
            return self.classifier(self.dropout(hidden))

    def encode(data):
        encoded = tokenizer(data['texts'], padding='max_length', truncation=True, max_length=128, return_tensors='pt')
        return torch.utils.data.TensorDataset(encoded['input_ids'], encoded['attention_mask'], torch.as_tensor(data['labels'], dtype=torch.long))

    loader = torch.utils.data.DataLoader(encode(train), batch_size=16, shuffle=True, num_workers=0)
    test_loader = torch.utils.data.DataLoader(encode(test), batch_size=32, shuffle=False, num_workers=0)
    model = BertClassifier().to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5)
    loss_fn = torch.nn.CrossEntropyLoss()
    started = time.monotonic()
    losses = []
    for epoch in range(epochs):
        model.train()
        loss_sum = count = 0
        for step, (ids, mask, labels) in enumerate(loader, 1):
            ids, mask, labels = ids.to(device), mask.to(device), labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            logits = model(ids, mask)
            loss = loss_fn(logits, labels)
            if not torch.isfinite(loss):
                raise RuntimeError('Nonfinite training loss')
            loss.backward()
            optimizer.step()
            loss_sum += float(loss.detach()) * len(labels)
            count += len(labels)
            if step % 25 == 0:
                print(json.dumps({'epoch': epoch + 1, 'step': step, 'steps': len(loader), 'trainLoss': loss_sum / count}), flush=True)
        losses.append(loss_sum / count)
    model.eval()
    correct = total = 0
    with torch.no_grad():
        for ids, mask, labels in test_loader:
            predictions = model(ids.to(device), mask.to(device)).argmax(1).cpu()
            correct += int((predictions == labels).sum())
            total += len(labels)
    # Save only inert CPU tensors, consumable with torch.load(weights_only=True).
    state = {key: value.detach().cpu() for key, value in model.state_dict().items()}
    torch.save(state, target)
    restored = torch.load(target, map_location='cpu', weights_only=True)
    model.cpu().load_state_dict(restored, strict=True)
    report_file(output, 'B17-provenance.json', {
        'kind': 'official-pretrained-bert-finetuned-on-fixed-AGNews', 'sourceId': 'B17',
        'pretrainedModel': 'google-bert/bert-base-uncased', 'pretrainedRevision': BERT_REVISION,
        'pretrainedFiles': {name: digest(pretrained / name) for name in required},
        'trainDataSha256': digest(data_dir / 'train.csv'), 'testDataSha256': digest(data_dir / 'test.csv'),
        'seed': 42, 'trainSamples': len(train['texts']), 'testSamples': total, 'epochs': epochs,
        'batchSize': 16, 'learningRate': 2e-5, 'maxLength': 128, 'device': str(device),
        'trainLoss': losses, 'testAccuracy': 100 * correct / total,
        'durationSeconds': round(time.monotonic() - started, 3), 'weightBytes': target.stat().st_size,
        'weightSha256': digest(target), 'strictReloadPassed': True, 'trainingAtEvaluation': False,
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--kind', choices=['bigram', 'bert'], required=True)
    parser.add_argument('--pretrained', type=pathlib.Path)
    parser.add_argument('--epochs', type=int, default=2)
    parser.add_argument('--train-samples', type=int, default=4000)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.kind == 'bigram':
        prepare_bigram(args.source, args.output)
    else:
        prepare_bert(args.source, args.output, args.pretrained, args.epochs, args.train_samples)


if __name__ == '__main__':
    main()

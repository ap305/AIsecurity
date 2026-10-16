ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONUTF8=1 \
    OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2 \
    NUMEXPR_NUM_THREADS=2 MPLBACKEND=Agg HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
COPY requirements.txt /opt/course-v3/requirements.txt
RUN python -m pip install --no-cache-dir -r /opt/course-v3/requirements.txt \
    && python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
       torch==2.5.1+cpu torchvision==0.20.1+cpu \
    && python -m pip check \
    && python -c "import torch, torchvision, sklearn, transformers, gymnasium, librosa; assert sklearn.__version__ == '1.6.1'" \
    && python -m pip freeze > /opt/course-v3/installed.txt \
    && chmod -R a+rX /opt/course-v3
# All teacher weights and hidden datasets are mounted only into the grader.
# This common image carries no credentials or private course assets.
WORKDIR /tmp

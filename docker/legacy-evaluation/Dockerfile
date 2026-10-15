ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONUTF8=1 \
    TORCH_HOME=/opt/torch-cache OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 NUMEXPR_NUM_THREADS=2
COPY requirements.txt /opt/legacy-runtime/requirements.txt
RUN python -m pip install --no-cache-dir -r /opt/legacy-runtime/requirements.txt \
    && python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
       torch==2.5.1+cpu torchvision==0.20.1+cpu \
    && python -m pip check \
    && python -m pip freeze > /opt/legacy-runtime/installed.txt
COPY provision_public_weights.py /opt/legacy-runtime/provision_public_weights.py
# Only the public ImageNet checkpoint belongs in the shared image. All course data
# and hidden evaluation labels remain in individual grader-only packages.
RUN python /opt/legacy-runtime/provision_public_weights.py \
    && chmod -R a+rX /opt/torch-cache /opt/legacy-runtime
WORKDIR /tmp


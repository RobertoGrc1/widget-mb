# La versión de la imagen DEBE coincidir con playwright==X en requirements.txt
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Un solo proceso: los tokens viven en memoria y no se comparten entre workers
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
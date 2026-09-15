"""Dock synthetic data generator.

Reproducible, seedable generator producing training data for the demand,
elasticity, congestion, weather-risk, and vessel-reliability models.

Run:  cd backend && .venv/bin/python -m data.generate --seed 42 --scale 1.0 --out data/generated
"""

__version__ = "0.1.0"
